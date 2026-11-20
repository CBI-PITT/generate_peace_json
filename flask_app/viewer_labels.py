"""Sparse OME-Zarr labels I/O for the browser viewer.

Only populated chunks are sent over the wire. A separate manual array records
painted background (label 0); the ordinary label array uses zero as its fill.
"""

import os
import re
import secrets
import shutil
import time

import numpy as np
import zarr
from flask import Blueprint, abort, jsonify, request, Response
from flask_login import current_user, login_required
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from numcodecs import Blosc

from flask_file_browser.routes import settings as browser_settings
from flask_file_browser.utils import get_path_map, get_config


viewer_labels = Blueprint('viewer_labels', __name__)
TILE = 256
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$')


def allowed_path(path, directory=False):
    """Resolve a picker path inside a root this user may browse."""
    if not isinstance(path, str) or not os.path.isabs(path) or any(
            part in ('.', '..') for part in path.split(os.sep)):
        abort(403)
    if any(ch in path for ch in ('\x00', '\n', '\r')):
        abort(403)
    real = os.path.realpath(path)
    if not (os.path.isdir(real) if directory else os.path.exists(real)):
        abort(404)
    roots = get_path_map(browser_settings, user_authenticated=True)
    for root_name, root_path in roots.items():
        root = os.path.realpath(os.path.expanduser(root_path))
        if real != root and not real.startswith(root + os.sep):
            continue
        if root_name not in browser_settings['dir_anon'] and browser_settings.getboolean(
                'auth', 'restrict_paths_to_matched_username', fallback=False):
            relative = os.path.relpath(real, root).split(os.sep)
            groups = get_config('groups.ini', allow_no_value=True)
            user = current_user.get_id().lower()
            allowed = [user] + [section.lower() for section in groups if section.lower() != 'all'
                                and user in [member.lower() for member in groups[section]]]
            admin = groups.has_section('all') and user in [member.lower() for member in groups['all']]
            if not admin and (not relative or relative[0].lower() not in allowed):
                continue
        return real
    abort(403)


def _label_array(group):
    if 'labels' in group and isinstance(group['labels'], zarr.hierarchy.Group):
        names = group.attrs.get('labels', [])
        if not names:
            names = list(group['labels'].group_keys())
        if not names:
            raise ValueError('No label group found')
        group = group['labels'][names[0]]
    array = group['0'] if '0' in group else group
    if not isinstance(array, zarr.core.Array) or array.ndim not in (2, 3):
        raise ValueError('Expected a 2D or z,y,x OME-Zarr labels array')
    if array.dtype.kind != 'u' or array.dtype.itemsize > 4:
        raise ValueError('Labels must be unsigned integers (up to 65535)')
    manual = group['manual']['0'] if 'manual' in group and '0' in group['manual'] else None
    if manual is not None and manual.shape != array.shape:
        raise ValueError('Annotation-state dimensions do not match labels')
    return group, array, manual


def _manifest(array, manual):
    """List possibly populated viewer tiles without reading zero-filled chunks."""
    occupied = set()
    for source in (array, manual):
        if source is None:
            continue
        prefix = source.path + '/'
        for key in source.store.keys():
            if not key.startswith(prefix):
                continue
            suffix = key[len(prefix):].replace('/', '.')
            if not re.fullmatch(r'\d+(?:\.\d+){1,2}', suffix):
                continue
            indices = [int(v) for v in suffix.split('.')]
            if source.ndim == 2:
                indices.insert(0, 0)
                chunks = (1,) + source.chunks
                height, width = source.shape
            else:
                chunks = source.chunks
                height, width = source.shape[1:]
            for z in range(indices[0] * chunks[0], min((indices[0] + 1) * chunks[0],
                                                        source.shape[0] if source.ndim == 3 else 1)):
                for ty in range(indices[1] * chunks[1] // TILE,
                                min(((indices[1] + 1) * chunks[1] - 1) // TILE + 1,
                                    (height - 1) // TILE + 1)):
                    for tx in range(indices[2] * chunks[2] // TILE,
                                    min(((indices[2] + 1) * chunks[2] - 1) // TILE + 1,
                                        (width - 1) // TILE + 1)):
                        occupied.add('%s:%s:%s' % (z, ty, tx))
    return sorted(occupied)


def _open(path):
    try:
        group = zarr.open_group(path, mode='r')
        return _label_array(group)
    except (KeyError, ValueError, TypeError, OSError) as exc:
        abort(400, description=str(exc))


@viewer_labels.route('/viewer/labels/info', methods=['POST'])
@login_required
def labels_info():
    path = allowed_path((request.get_json(silent=True) or {}).get('path'), directory=True)
    if not path.lower().endswith('.zarr'):
        abort(400, description='Select an .ome.zarr or .zarr folder')
    group, array, manual = _open(path)
    shape = list(array.shape)
    if array.ndim == 2:
        shape.insert(0, 1)
    return jsonify({'shape': shape, 'tiles': _manifest(array, manual),
                    'colors': group.attrs.get('image-label', {}).get('colors', [])})


@viewer_labels.route('/viewer/labels/tile', methods=['POST'])
@login_required
def labels_tile():
    data = request.get_json(silent=True) or {}
    path = allowed_path(data.get('path'), directory=True)
    if not path.lower().endswith('.zarr'):
        abort(400)
    _, array, manual = _open(path)
    try:
        z, ty, tx = (int(data[k]) for k in ('z', 'ty', 'tx'))
    except (ValueError, KeyError, TypeError):
        abort(400)
    zs, height, width = ((array.shape[0], array.shape[1], array.shape[2])
                         if array.ndim == 3 else (1, array.shape[0], array.shape[1]))
    if z < 0 or z >= zs or ty < 0 or tx < 0 or ty * TILE >= height or tx * TILE >= width:
        abort(400)
    y0, x0 = ty * TILE, tx * TILE
    area = (slice(y0, min(y0 + TILE, height)), slice(x0, min(x0 + TILE, width)))
    selection = ((z,) + area) if array.ndim == 3 else area
    values = np.asarray(array[selection])
    if values.size and values.max() > 65535:
        abort(400, description='Label number exceeds 65535')
    labels = np.zeros((TILE, TILE), dtype='<u2')
    annotations = np.zeros((TILE, TILE), dtype='u1')
    h, w = values.shape
    labels[:h, :w] = values
    annotations[:h, :w] = (np.asarray(manual[selection]) != 0 if manual is not None else values != 0)
    return Response(labels.tobytes() + annotations.tobytes(), mimetype='application/octet-stream')


def _signer():
    from flask import current_app
    return URLSafeTimedSerializer(current_app.secret_key, salt='viewer-label-export')


def _remove_pending(path):
    # On the deployed NFS mount a just-removed Zarr chunk can remain visible
    # briefly to rmtree's parent rmdir. Retry the directory pass after the
    # directory cache settles (also used after an interrupted export).
    for attempt in range(10):
        if not os.path.exists(path):
            return
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            if not os.path.exists(path):
                return
        except OSError:
            if attempt == 9:
                raise
        time.sleep(0.1)


def _export(data):
    try:
        payload = _signer().loads(data.get('token', ''), max_age=60 * 60 * 12)
    except (BadSignature, SignatureExpired):
        abort(403)
    if payload['user'] != current_user.get_id():
        abort(403)
    parent = allowed_path(payload['parent'], directory=True)
    name = payload['name']
    pending = os.path.join(parent, '.' + name + '.pending-' + payload['id'])
    final = os.path.join(parent, name)
    if not os.path.isdir(pending) or os.path.islink(pending):
        abort(404)
    return payload, pending, final


@viewer_labels.route('/viewer/labels/begin', methods=['POST'])
@login_required
def labels_begin():
    data = request.get_json(silent=True) or {}
    parent = allowed_path(data.get('parent'), directory=True)
    name = data.get('name')
    shape = data.get('shape')
    if not isinstance(name, str) or not NAME_RE.fullmatch(name) or not name.endswith('.ome.zarr'):
        abort(400, description='Enter a safe .ome.zarr folder name')
    if not isinstance(shape, list) or len(shape) != 3 or any(
            type(n) is not int or n < 1 or n > 100000 for n in shape):
        abort(400, description='Invalid z,y,x dimensions')
    final = os.path.join(parent, name)
    if os.path.lexists(final):
        abort(409, description='A folder with that name already exists')
    ident = secrets.token_hex(16)
    pending = os.path.join(parent, '.' + name + '.pending-' + ident)
    try:
        os.mkdir(pending)
        root = zarr.open_group(pending, mode='a')
        compressor = Blosc(cname='zstd', clevel=3, shuffle=Blosc.BITSHUFFLE)
        # The metadata-only root array satisfies the NGFF image+labels layout
        # without duplicating the referenced TIFF image's pixels.
        root.create_dataset('0', shape=shape, chunks=(1, TILE, TILE), dtype='u1', fill_value=0,
                            compressor=compressor)
        multiscales = [{'version': '0.4', 'axes': [
            {'name': axis, 'type': kind} for axis, kind in
            (('z', 'space'), ('y', 'space'), ('x', 'space'))],
            'datasets': [{'path': '0', 'coordinateTransformations': [
                {'type': 'scale', 'scale': [1, 1, 1]}]}]}]
        root.attrs.update({'multiscales': multiscales, 'labels': ['segmentation']})
        labels = root.create_group('labels').create_group('segmentation')
        labels.create_dataset('0', shape=shape, chunks=(1, TILE, TILE), dtype='<u2',
                              fill_value=0, compressor=compressor)
        manual = labels.create_group('manual')
        manual.create_dataset('0', shape=shape, chunks=(1, TILE, TILE), dtype='u1',
                              fill_value=0, compressor=compressor)
        labels.attrs.update({'multiscales': multiscales,
                             'image-label': {'version': '0.4', 'colors': data.get('colors', []),
                                             'properties': []},
                             'peace_manual_dataset': 'manual/0'})
    except Exception:
        if os.path.isdir(pending):
            _remove_pending(pending)
        raise
    payload = {'user': current_user.get_id(), 'parent': parent, 'name': name,
               'id': ident, 'shape': shape}
    return jsonify({'token': _signer().dumps(payload)})


@viewer_labels.route('/viewer/labels/write_tile', methods=['POST'])
@login_required
def labels_write_tile():
    payload, pending, _ = _export(request.args)
    try:
        z, ty, tx = (int(request.args[k]) for k in ('z', 'ty', 'tx'))
    except (ValueError, KeyError):
        abort(400)
    zs, height, width = payload['shape']
    if z < 0 or z >= zs or ty < 0 or tx < 0 or ty * TILE >= height or tx * TILE >= width:
        abort(400)
    raw = request.get_data()
    if len(raw) != TILE * TILE * 3:
        abort(400, description='Incorrect tile size')
    labels = np.frombuffer(raw[:TILE * TILE * 2], dtype='<u2').reshape(TILE, TILE)
    manual = np.frombuffer(raw[TILE * TILE * 2:], dtype='u1').reshape(TILE, TILE)
    if np.any(manual > 1):
        abort(400)
    h = min(TILE, height - ty * TILE)
    w = min(TILE, width - tx * TILE)
    y0, x0 = ty * TILE, tx * TILE
    group = zarr.open_group(pending, mode='a')['labels']['segmentation']
    if np.any(labels[:h, :w]):
        group['0'][z, y0:y0 + h, x0:x0 + w] = labels[:h, :w]
    if np.any(manual[:h, :w]):
        group['manual']['0'][z, y0:y0 + h, x0:x0 + w] = manual[:h, :w]
    return jsonify({'ok': True})


@viewer_labels.route('/viewer/labels/finish', methods=['POST'])
@login_required
def labels_finish():
    _, pending, final = _export(request.get_json(silent=True) or {})
    if os.path.lexists(final):
        abort(409, description='Destination already exists')
    os.rename(pending, final)
    return jsonify({'path': final})


@viewer_labels.route('/viewer/labels/cancel', methods=['POST'])
@login_required
def labels_cancel():
    _, pending, _ = _export(request.get_json(silent=True) or {})
    _remove_pending(pending)
    return jsonify({'ok': True})
