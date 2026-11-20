"""Sparse label import/export and pixel-classifier behavior."""

import configparser
import subprocess

import numpy as np
import pytest
import zarr

from conftest import FLASK_APP


@pytest.fixture()
def label_api(peace_app, monkeypatch, tmp_path):
    import viewer_labels

    settings = configparser.ConfigParser()
    settings['dir_auth'] = {'test': str(tmp_path)}
    settings['dir_anon'] = {}
    settings['auth'] = {'restrict_paths_to_matched_username': 'False'}
    monkeypatch.setattr(viewer_labels, 'browser_settings', settings)
    return viewer_labels


def tile_data(label=0, manual=0, predicted=0):
    values = np.zeros((256, 256), dtype='<u2')
    annotations = np.zeros((256, 256), dtype='u1')
    values[0, 0] = label
    annotations[0, 0] = manual
    values[0, 1] = predicted
    return values.tobytes() + annotations.tobytes()


def test_labels_export_import_sparse_and_background(client, login_session, label_api, tmp_path):
    login_session()
    begin = client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path), 'name': 'mask.ome.zarr', 'shape': [2, 4, 5],
        'colors': [{'label-value': 7, 'rgba': [255, 0, 0, 255]}],
    })
    assert begin.status_code == 200
    token = begin.json['token']
    response = client.post('/viewer/labels/write_tile', query_string={
        'token': token, 'z': 0, 'ty': 0, 'tx': 0,
    }, data=tile_data(label=0, manual=1, predicted=7))
    assert response.status_code == 200
    assert client.post('/viewer/labels/finish', json={'token': token}).status_code == 200

    root = zarr.open_group(str(tmp_path / 'mask.ome.zarr'), mode='r')
    labels = root['labels']['segmentation']
    assert root.attrs['labels'] == ['segmentation']
    assert root.attrs['multiscales'][0]['axes'][0]['name'] == 'z'
    assert labels.attrs['image-label']['version'] == '0.4'
    assert labels['0'].shape == (2, 4, 5)
    assert labels['0'][0, 0, 1] == 7
    assert labels['manual']['0'][0, 0, 0] == 1  # hand-painted background
    assert labels['manual']['0'][0, 0, 1] == 0  # model prediction
    assert not (tmp_path / 'mask.ome.zarr/labels/segmentation/0/1.0.0').exists()
    assert not (tmp_path / 'mask.ome.zarr/0/0.0.0').exists()  # no copied image zeros

    info = client.post('/viewer/labels/info', json={'path': str(tmp_path / 'mask.ome.zarr')})
    assert info.status_code == 200
    assert info.json['shape'] == [2, 4, 5]
    assert info.json['tiles'] == ['0:0:0']
    tile = client.post('/viewer/labels/tile', json={
        'path': str(tmp_path / 'mask.ome.zarr'), 'z': 0, 'ty': 0, 'tx': 0,
    })
    assert tile.status_code == 200
    assert np.frombuffer(tile.data[:256 * 256 * 2], dtype='<u2')[1] == 7
    assert tile.data[256 * 256 * 2] == 1
    assert tile.data[256 * 256 * 2 + 1] == 0
    assert client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path), 'name': 'mask.ome.zarr', 'shape': [2, 4, 5],
    }).status_code == 409


def test_external_2d_zarr_without_manual_uses_nonzero_as_annotation(client, login_session, label_api, tmp_path):
    login_session()
    path = tmp_path / 'external.ome.zarr'
    group = zarr.open_group(str(path), mode='w')
    array = group.create_dataset('0', shape=(4, 5), chunks=(512, 512), dtype='u2', fill_value=0)
    array[3, 4] = 12
    info = client.post('/viewer/labels/info', json={'path': str(path)})
    assert info.status_code == 200
    assert info.json['shape'] == [1, 4, 5]
    assert info.json['tiles'] == ['0:0:0']
    tile = client.post('/viewer/labels/tile', json={
        'path': str(path), 'z': 0, 'ty': 0, 'tx': 0,
    })
    assert tile.status_code == 200
    i = 3 * 256 + 4
    assert np.frombuffer(tile.data[:256 * 256 * 2], dtype='<u2')[i] == 12
    assert tile.data[256 * 256 * 2 + i] == 1
    assert tile.data[256 * 256 * 2] == 0


def test_export_path_and_upload_validation(client, login_session, label_api, tmp_path):
    path = tmp_path / 'mask.ome.zarr'
    assert client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path), 'name': 'mask.ome.zarr', 'shape': [1, 4, 4],
    }).status_code == 302
    login_session()
    assert client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path / '..'), 'name': 'mask.ome.zarr', 'shape': [1, 4, 4],
    }).status_code == 403
    assert client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path), 'name': '../escape.ome.zarr', 'shape': [1, 4, 4],
    }).status_code == 400
    token = client.post('/viewer/labels/begin', json={
        'parent': str(tmp_path), 'name': 'mask.ome.zarr', 'shape': [1, 4, 4],
    }).json['token']
    assert client.post('/viewer/labels/write_tile', query_string={
        'token': token, 'z': 1, 'ty': 0, 'tx': 0,
    }, data=tile_data(3, 1)).status_code == 400
    assert client.post('/viewer/labels/write_tile', query_string={
        'token': token, 'z': 0, 'ty': 0, 'tx': 0,
    }, data=b'bad').status_code == 400
    assert client.post('/viewer/labels/cancel', json={'token': token}).status_code == 200
    assert not path.exists()
    assert client.post('/viewer/labels/finish', json={'token': token}).status_code == 404
    assert client.post('/viewer/labels/info', json={'path': '/etc'}).status_code == 403


def test_label_worker_trains_all_pixels_and_preserves_manual():
    worker = FLASK_APP / 'static/viewer/labels_worker.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let messages = [];
const self = {postMessage: (value) => messages.push(value)};
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), {self, Math,
    Float32Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Float64Array,
    isFinite, Error, Array, Object});
const targets = new Uint16Array([0,0,0,0,1,1,1,1]);
const features = new Float32Array(targets.length * 121);
for (let i=4; i<8; i++) features.fill(1, i*121, (i+1)*121);
self.onmessage({data:{type:'train', features:features.buffer, targets:targets.buffer, classes:[0,1]}});
const trained = messages.find(m => m.result);
assert(trained && trained.result.count === 8);
assert(isFinite(trained.result.loss));
assert.deepStrictEqual(Array.from(trained.result.model.classes), [0,1]);
messages = [];
const values = new Uint16Array(256*256);
const manual = new Uint8Array(256*256);
values[0] = 1; manual[0] = 1;
const raw = new Uint8Array(4*4); raw.fill(255);
self.onmessage({data:{type:'predict', model:trained.result.model, arrayType:'Uint8Array',
    raw:raw.buffer, values:values.buffer, manual:manual.buffer, width:4, height:4,
    ox:0, oy:0, fullWidth:4, fullHeight:4, tx:0, ty:0, tileWidth:2, tileHeight:2,
    range:{min:0,max:255}}});
const result = messages.find(m => m.result);
assert(result && result.result.count === 3);
assert.strictEqual(new Uint16Array(result.result.values)[0], 1);
assert([0,1].includes(new Uint16Array(result.result.values)[1]));
'''
    result = subprocess.run(['node', '-e', script, str(worker)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_label_worker_grouped_strokes_still_converge():
    """Regression: strokes arrive grouped by painted region (background pixels
    first, then each foreground label). In-order class-pure mini-batches made
    the loss pin at the random-guess baseline and argmax collapse to label 1
    across the whole plane; the worker must shuffle internally."""
    worker = FLASK_APP / 'static/viewer/labels_worker.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let messages = [];
let errors = [];
const self = {postMessage: (value) => {
    if (value.error) errors.push(value.error); else messages.push(value);
}};
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), {self, Math,
    Float32Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Float64Array,
    isFinite, Error, Array, Object});
// Grouped exactly like viewer.js collects them: 300 background stroke
// pixels, then 300 foreground stroke pixels.
const perClass = 300;
const targets = new Uint16Array(perClass * 2);
const features = new Float32Array(perClass * 2 * 121);
for (let i = 0; i < perClass * 2; i++) {
    const dark = i < perClass;
    for (let p = 0; p < 121; p++) {
        features[i * 121 + p] = (dark ? 2000 + Math.random() * 2000
                                      : 40000 + Math.random() * 8000) / 65535;
    }
    targets[i] = dark ? 0 : 1;
}
self.onmessage({data:{type:'train', features:features.buffer, targets:targets.buffer, classes:[0,1]}});
assert.deepStrictEqual(errors, []);
const trained = messages.filter(m => m.result)[0].result;
assert(trained && trained.count === perClass * 2);
assert(isFinite(trained.loss));
assert(trained.loss < 0.4, 'grouped strokes did not converge: loss ' + trained.loss);
// Fresh plane: bright square on a dark background, like the reported case.
const raw = new Uint8Array(64 * 64);
for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) raw[y * 64 + x] = 200;
const values = new Uint16Array(256 * 256);
const manual = new Uint8Array(256 * 256);
self.onmessage({data:{type:'predict', model:trained.model, arrayType:'Uint8Array',
    raw:raw.buffer, values:values.buffer, manual:manual.buffer, width:64, height:64,
    ox:0, oy:0, fullWidth:64, fullHeight:64, tx:0, ty:0, tileWidth:64, tileHeight:64,
    range:{min:0, max:255}}});
assert.deepStrictEqual(errors, []);
const out = new Uint16Array(messages.filter(m => m.result)[1].result.values);
assert.strictEqual(out[30 * 256 + 30], 1, 'bright pixel predicted as background');
assert.strictEqual(out[50 * 256 + 5], 0, 'dark pixel predicted as foreground');
assert.strictEqual(out[60 * 256 + 60], 0, 'dark pixel predicted as foreground');
'''
    result = subprocess.run(['node', '-e', script, str(worker)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_label_worker_convergence_guard_fires_on_indistinguishable_classes():
    """The guard must refuse a useless model: identical features labeled 0 and
    1 make the best achievable loss equal the random-guess baseline, so the
    worker reports an error instead of returning a collapsed model."""
    worker = FLASK_APP / 'static/viewer/labels_worker.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let messages = [];
let errors = [];
const self = {postMessage: (value) => {
    if (value.error) errors.push(value.error); else messages.push(value);
}};
vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), {self, Math,
    Float32Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Float64Array,
    isFinite, Error, Array, Object});
const perClass = 100;
const targets = new Uint16Array(perClass * 2);
const features = new Float32Array(perClass * 2 * 121);
for (let i = 0; i < perClass * 2; i++) {
    for (let p = 0; p < 121; p++) features[i * 121 + p] = 0.5;
    targets[i] = i < perClass ? 0 : 1;
}
self.onmessage({data:{type:'train', features:features.buffer, targets:targets.buffer, classes:[0,1]}});
assert.deepStrictEqual(messages.filter(m => m.result), [], 'a model was returned');
assert.strictEqual(errors.length, 1);
assert(errors[0].indexOf('did not converge') !== -1, 'unexpected error: ' + errors[0]);
'''
    result = subprocess.run(['node', '-e', script, str(worker)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_viewer_sparse_drawing_tiff_import_and_empty_points():
    viewer = FLASK_APP / 'static/viewer/viewer.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let source = fs.readFileSync(process.argv[1], 'utf8');
source = source.replace(/\}\)\(\);\s*$/, `
    renderLayerList = function () {};
    syncSliders = function () {};
    renderToolsPanel = function () {};
    draw = function () {};
    globalThis.viewerTest = {layers, layerById, newLabelsLayer, labelsTile,
        stampLabels, addEmptyPointsLayer, addPointAtClick, activePointsLayer,
        loadTiffLabelsPlane, removeLayer, view};
})();`);
const context = {document: {readyState:'loading', addEventListener() {}},
    window: {addEventListener() {}}, console, Map, Set, Uint8Array, Uint16Array,
    Math, Promise, Date};
vm.runInNewContext(source, context);
const v = context.viewerTest;
v.layers.push({id:100, type:'image', visible:true, ready:true,
    fullWidth:16, fullHeight:16, zCount:3, z:2});
const layer = v.newLabelsLayer('blank');
assert(layer && layer.zCount === 3 && layer.imageId === 100);
layer.size = 2;
layer.number = 7;
(async () => {
    await v.stampLabels(layer, 2, 5, 5, false);
    const tile = v.labelsTile(layer, 2, 0, 0);
    assert.strictEqual(tile.values[5*256+5], 7);
    assert.strictEqual(tile.manual[5*256+5], 1);
    layer.number = 0;
    await v.stampLabels(layer, 2, 10, 10, false);
    assert.strictEqual(tile.values[10*256+10], 0);
    assert.strictEqual(tile.manual[10*256+10], 1); // painted background
    await v.stampLabels(layer, 2, 10, 10, true);
    assert.strictEqual(tile.manual[10*256+10], 0); // erased, not background
    v.addEmptyPointsLayer();
    assert.strictEqual(v.activePointsLayer().hasZ, true);
    v.addPointAtClick(3, 4);
    assert.strictEqual(v.activePointsLayer().coords[0].z, 2);
    const imported = v.newLabelsLayer('TIFF');
    const data = new Uint16Array(16*16); data[3*16+4] = 9;
    imported.source = {type:'tiff', pages:1, urls:['mask.tif'],
        tiff:{getImage: async () => ({getWidth:()=>16, getHeight:()=>16,
            getSamplesPerPixel:()=>1, readRasters:async()=>[data]})}};
    imported.sourceZ = 2;
    await v.loadTiffLabelsPlane(imported, 2);
    const mask = v.labelsTile(imported, 2, 0, 0);
    assert.strictEqual(mask.values[3*256+4], 9);
    assert.strictEqual(mask.manual[3*256+4], 1);
    assert.strictEqual(mask.manual[0], 0); // TIFF zeros are unannotated
    v.removeLayer(100);
    assert.strictEqual(v.layerById(layer.id), null);
    assert.strictEqual(v.layerById(imported.id), null);
})().catch(err => {console.error(err); process.exitCode=1;});
'''
    result = subprocess.run(['node', '-e', script, str(viewer)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_viewer_training_uses_all_z_and_predicts_only_current_z():
    viewer = FLASK_APP / 'static/viewer/viewer.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let source = fs.readFileSync(process.argv[1], 'utf8');
source = source.replace(/\}\)\(\);\s*$/, `
    renderLayerList = function () {};
    syncSliders = function () {};
    renderToolsPanel = function () {};
    draw = function () {};
    globalThis.viewerTest = {layers, newLabelsLayer, labelsTile, stampLabels,
        trainLabels, predictLabels};
})();`);
let trainingCount = 0;
class WorkerMock {
    postMessage(message) {
        if (message.type === 'train') {
            const labels = new Uint16Array(message.targets);
            trainingCount = labels.length;
            assert.deepStrictEqual(Array.from(labels).sort(), [0,7]);
            this.onmessage({data:{result:{model:{classes:[0,7]},count:labels.length,loss:0.1}}});
        } else {
            const values = new Uint16Array(message.values);
            const manual = new Uint8Array(message.manual);
            for (let y=0; y<message.tileHeight; y++) for (let x=0; x<message.tileWidth; x++) {
                const i = y*256+x;
                if (!manual[i]) values[i] = 7;
            }
            this.onmessage({data:{result:{values:values.buffer,count:values.length}}});
        }
    }
    terminate() {}
}
const context = {document: {readyState:'loading', addEventListener() {}},
    window: {addEventListener() {}, labelsWorkerUrl:'/worker.js'}, console,
    Worker:WorkerMock, Map, Set, Uint8Array, Uint16Array, Float32Array,
    Math, Promise, Date};
vm.runInNewContext(source, context);
const v = context.viewerTest;
const dark = new Uint8Array(16*16), bright = new Uint8Array(16*16); bright.fill(255);
const slice = (pixels) => ({width:16,height:16,ox:0,oy:0,spp:1,
    interleaved:false,data:[pixels]});
const image = {id:101,type:'image',visible:true,ready:true,fullWidth:16,
    fullHeight:16,zCount:3,z:2,singleStrip:true,slices:new Map([[0,slice(dark)],[2,slice(bright)]]),
    contrastDomain:{min:0,max:255}};
v.layers.push(image);
const layer = v.newLabelsLayer('train');
layer.size = 1;
(async () => {
    layer.number = 0;
    await v.stampLabels(layer,0,2,2,false);
    layer.number = 7;
    await v.stampLabels(layer,2,3,3,false);
    await v.trainLabels();
    assert.strictEqual(trainingCount,2); // both z planes, including background
    assert(layer.model);
    await v.predictLabels();
    const current = v.labelsTile(layer,2,0,0);
    const earlier = v.labelsTile(layer,0,0,0);
    assert.strictEqual(current.values[3*256+3],7);
    assert.strictEqual(current.manual[3*256+3],1);
    assert.strictEqual(current.values[0],7); // predicted on current z
    assert.strictEqual(current.manual[0],0);
    assert.strictEqual(earlier.values[2*256+2],0);
    assert.strictEqual(earlier.manual[2*256+2],1);
    assert.strictEqual(earlier.values[0],0); // other z not predicted
})().catch(err => {console.error(err); process.exitCode=1;});
'''
    result = subprocess.run(['node', '-e', script, str(viewer)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_viewer_display_pipeline_renders_predicted_labels():
    """Display-level regression: Train + Predict + draw() must paint predicted
    foreground AND predicted background (label-0 grey, lighter than manual)."""
    worker = FLASK_APP / 'static/viewer/labels_worker.js'
    viewer = FLASK_APP / 'static/viewer/viewer.js'
    script = r'''
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const workerSource = fs.readFileSync(process.argv[1], 'utf8');

// Real worker script executed in-process (synchronous message round-trips).
class RealWorker {
    constructor() {
        const ref = this;
        const self = {};
        self.postMessage = (msg) => { if (ref.onmessage) ref.onmessage({data: msg}); };
        vm.runInNewContext(workerSource, {self, Math, console,
            Float32Array, Uint8Array, Uint16Array, Uint32Array, Int16Array,
            Float64Array, isFinite, Error, Array, Object});
        this.self = self;
    }
    postMessage(message) { this.self.onmessage({data: message}); }
    terminate() {}
}

function fakeCanvas() {
    const canvas = {width: 0, height: 0, imageData: null};
    canvas.getContext = () => ({putImageData: (d) => { canvas.imageData = d; }});
    return canvas;
}
const drawImageCalls = [];
const fakeCtx = {
    setTransform(){}, clearRect(){}, fillRect(){}, beginPath(){}, arc(){},
    fill(){}, stroke(){}, strokeRect(){}, setLineDash(){},
    imageSmoothingEnabled: true, fillStyle: '', strokeStyle: '', lineWidth: 1,
    drawImage: (src, x, y) => drawImageCalls.push({source: src, x: x, y: y}),
    putImageData(){},
};
class ImageData {
    constructor(data, w, h) { this.data = data; this.width = w; this.height = h; }
}
const document = {
    readyState: 'loading', addEventListener(){},
    createElement: (tag) => tag === 'canvas' ? fakeCanvas() : {},
};
const window = {addEventListener(){}, labelsWorkerUrl: '/worker.js', Worker: RealWorker};

    let source = fs.readFileSync(process.argv[2], 'utf8');
    source = source.replace(/\}\)\(\);\s*$/, `
    renderLayerList = function () {};
    syncSliders = function () {};
    renderToolsPanel = function () {};
    errorHint = function (text) { globalThis.viewerTest.errors.push(text); };
    showHint = function () {};
    function setupStage(ctx2) {
        ctx = ctx2; canvasW = 64; canvasH = 64; dpr = 1;
        view.scale = 1; view.tx = 0; view.ty = 0; view.fitted = true;
        el = {canvas: {width: 64, height: 64}};
    }
    globalThis.viewerTest = {errors: [], setup: setupStage,
        api: {layers, newLabelsLayer, stampLabels, trainLabels,
              predictLabels, draw, labelsTile, view, layerById}};
})();`);
    const context = {document, window, ImageData, Worker: RealWorker, console, Map, Set, Uint8Array,
        Uint16Array, Uint32Array, Int16Array, Float32Array, Float64Array, Math,
        Promise, Date, isFinite, Error, Array, Object};
vm.runInNewContext(source, context);
const v = context.viewerTest.api;

const pixels = new Uint8Array(64 * 64);
for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) pixels[y * 64 + x] = 200;
context.viewerTest.setup(fakeCtx);
v.layers.push({id: 101, type: 'image', visible: true, ready: true, z: 0, zCount: 1,
    fullWidth: 64, fullHeight: 64, singleStrip: true,
    slices: new Map([[0, {width: 64, height: 64, ox: 0, oy: 0, spp: 1,
        interleaved: false, data: [pixels]}]]),
        paint: new Map([[0, {canvas: {}, ox: 0, oy: 0}]]),
        contrast: {min: 0, max: 255},
        contrastDomain: {min: 0, max: 255}});

const layer = v.newLabelsLayer('display');
assert(layer && layer.width === 64 && layer.zCount === 1);
layer.size = 1;
(async () => {
    layer.number = 7;
    await v.stampLabels(layer, 0, 30, 30, false);  // manual foreground (bright)
    layer.number = 0;
    await v.stampLabels(layer, 0, 5, 5, false);    // manual background (dark)
    await v.trainLabels();
    assert(layer.model, 'training produced no model');
    await v.predictLabels();
    const errs = context.viewerTest.errors;
    assert.strictEqual(errs.length, 0, 'errors: ' + errs.join(' | '));
    const tile = v.labelsTile(layer, 0, 0, 0);
    assert.strictEqual(tile.values[30 * 256 + 31], 7);   // predicted foreground
    assert.strictEqual(tile.pred[30 * 256 + 31], 1);
    assert.strictEqual(tile.values[6 * 256 + 5], 0);     // predicted background below the stroke
    assert.strictEqual(tile.pred[6 * 256 + 5], 1);
    assert.strictEqual(tile.values[50 * 256 + 50], 0);   // predicted background away from strokes
    assert.strictEqual(tile.pred[50 * 256 + 50], 1);
    v.draw();
    const draws = drawImageCalls.filter(c => c.source.imageData && c.source.width === 256);
    assert(draws.length >= 1, 'labels tiles were never drawn on the main canvas');
    const last = draws[draws.length - 1];
    const px = (x, y) => {
        const i = (y * 256 + x) * 4;
        return Array.from(last.source.imageData.data.slice(i, i + 4));
    };
    // manual foreground: full alpha, class color
    assert.deepStrictEqual(px(30, 30), [34, 197, 94, 145]);
    // predicted foreground: lighter alpha, same class color
    assert.deepStrictEqual(px(30, 31), [34, 197, 94, 80]);
    // manual background stroke: full alpha, label-0 grey
    assert.deepStrictEqual(px(5, 5), [184, 199, 217, 145]);
    // predicted background: label-0 grey, lighter alpha
    assert.deepStrictEqual(px(5, 6), [184, 199, 217, 80]);
    // predicted background away from the strokes: label-0 grey, lighter alpha
    assert.deepStrictEqual(px(50, 50), [184, 199, 217, 80]);
    // manual paint clears predicted state
    layer.number = 3;
    await v.stampLabels(layer, 0, 5, 6, false);
    assert.strictEqual(tile.pred[6 * 256 + 5], 0);
    assert.strictEqual(tile.values[6 * 256 + 5], 3);
})().catch(err => {console.error(err); process.exitCode=1;});
'''
    result = subprocess.run(['node', '-e', script, str(worker), str(viewer)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
