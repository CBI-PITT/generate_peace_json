"""Login auth-chain tests: FreeIPA first, then the existing AD (NTLM) fallback.

No LDAP is ever contacted: ipa_authenticate/domain_auth are monkeypatched on
the auth module (login_post resolves them as module globals), and the [auth]
flags are toggled on the live settings configparser (flask_file_browser.routes.
settings) that login_post closes over, restoring the original values after
each test. The file makes 8 POSTs in total, under the 10/minute login limit.
"""


import pytest


@pytest.fixture()
def auth_option():
    """Set/restore [auth] options on the live settings configparser that
    login_post closes over (the configparser object itself is mutable)."""
    from flask_file_browser.routes import settings

    saved = {}

    def _set(option, value):
        if option not in saved:
            saved[option] = (settings.get('auth', option)
                             if settings.has_option('auth', option) else None)
        if value is None:
            settings.remove_option('auth', option)
        else:
            settings.set('auth', option, value)

    yield _set

    for option, original in saved.items():
        if original is None:
            settings.remove_option('auth', option)
        else:
            settings.set('auth', option, original)


@pytest.fixture()
def fake_auth(peace_app, monkeypatch):
    """Stand-ins for ipa_authenticate/domain_auth recording their calls.
    Results are configured through the returned dict: True, False, None or
    an Exception instance (raised)."""
    import auth as auth_module

    state = {
        'ipa_result': False,
        'domain_result': False,
        'ipa_calls': [],
        'domain_calls': [],
    }

    def _ipa(username, password, server='ipa.cbiserver.pitt.edu', use_tls=True, ca_file=None):
        state['ipa_calls'].append((username, password, server, use_tls, ca_file))
        result = state['ipa_result']
        if isinstance(result, Exception):
            raise result
        return result

    def _domain(username, password, domain_server=None, domain=None):
        state['domain_calls'].append((username, password, domain_server, domain))
        return state['domain_result']

    monkeypatch.setattr(auth_module, 'ipa_authenticate', _ipa)
    monkeypatch.setattr(auth_module, 'domain_auth', _domain)
    return state


def _post_login(client, username='test_user', password='secret', **kwargs):
    return client.post('/login', data={'username': username,
                                       'password': password}, **kwargs)


def test_ipa_success_short_circuits_domain(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    fake_auth['ipa_result'] = True
    resp = _post_login(client)
    assert resp.status_code == 302, resp.data
    assert resp.location == '/', resp.location
    assert len(fake_auth['ipa_calls']) == 1, fake_auth['ipa_calls']
    assert fake_auth['domain_calls'] == [], fake_auth['domain_calls']


def test_ipa_server_and_tls_settings_are_passed(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    auth_option('ipa_server', 'ipa.example.org')
    auth_option('ipa_use_tls', 'False')
    auth_option('ipa_ca_file', '/tmp/ipa-ca.crt')
    fake_auth['ipa_result'] = True
    _post_login(client)
    assert len(fake_auth['ipa_calls']) == 1
    username, password, server, use_tls, ca_file = fake_auth['ipa_calls'][0]
    assert username == 'test_user'
    assert password == 'secret'
    assert server == 'ipa.example.org'
    assert use_tls is False
    assert ca_file == '/tmp/ipa-ca.crt'


def test_ipa_rejection_falls_back_to_domain(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    fake_auth['ipa_result'] = False
    fake_auth['domain_result'] = True
    resp = _post_login(client)
    assert resp.status_code == 302, resp.data
    assert resp.location == '/', resp.location
    assert len(fake_auth['ipa_calls']) == 1, fake_auth['ipa_calls']
    assert len(fake_auth['domain_calls']) == 1, fake_auth['domain_calls']


def test_ipa_unreachable_falls_back_to_domain(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    fake_auth['ipa_result'] = ConnectionError('LDAP connection down')
    fake_auth['domain_result'] = True
    resp = _post_login(client)
    assert resp.status_code == 302, resp.data
    assert resp.location == '/', resp.location
    assert len(fake_auth['ipa_calls']) == 1, fake_auth['ipa_calls']
    assert len(fake_auth['domain_calls']) == 1, fake_auth['domain_calls']


def test_both_fail_shows_invalid_credentials(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    fake_auth['ipa_result'] = False
    fake_auth['domain_result'] = False
    resp = _post_login(client, follow_redirects=True)
    assert resp.status_code == 200, resp.data
    assert b'Your credentials are not valid' in resp.data, resp.data
    assert len(fake_auth['ipa_calls']) == 1
    assert len(fake_auth['domain_calls']) == 1


def test_domain_error_shows_error_flash(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'True')
    fake_auth['ipa_result'] = False
    fake_auth['domain_result'] = None
    resp = _post_login(client, follow_redirects=True)
    assert resp.status_code == 200, resp.data
    assert b'An error occured during login' in resp.data, resp.data


def test_ipa_disabled_uses_domain_only(client, fake_auth, auth_option):
    auth_option('ipa_auth', 'False')
    fake_auth['domain_result'] = True
    resp = _post_login(client)
    assert resp.status_code == 302, resp.data
    assert resp.location == '/', resp.location
    assert fake_auth['ipa_calls'] == [], fake_auth['ipa_calls']
    assert len(fake_auth['domain_calls']) == 1, fake_auth['domain_calls']


def test_bypass_auth_skips_ldap(client, fake_auth, auth_option):
    auth_option('bypass_auth', 'True')
    resp = _post_login(client)
    assert resp.status_code == 302, resp.data
    assert resp.location == '/', resp.location
    assert fake_auth['ipa_calls'] == [], fake_auth['ipa_calls']
    assert fake_auth['domain_calls'] == [], fake_auth['domain_calls']
