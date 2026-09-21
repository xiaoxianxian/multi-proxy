"""
E2E-style integration tests for hermes-proxy HTTP endpoints.

These tests verify end-to-end behavior by:
1. Creating a temporary config directory with valid YAML config
2. Patching proxy module globals (HOME, CONFIG_YAML_PATH, etc.)
3. Using Flask's test client to make real HTTP requests
4. Verifying response structure, status codes, and behavior

Since hermes-proxy does NOT implement /v1/chat/completions (only admin/routing
endpoints), the "E2E" here covers all operational endpoints to ensure the
Flask app responds correctly under various config scenarios.
"""

import json
import os
import sys
import tempfile
import shutil
from unittest.mock import patch, MagicMock

import pytest
import yaml

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def _create_tmp_config(tmpdir, models=None):
    """Create a minimal Hermes config.yaml in tmpdir."""
    config_dir = os.path.join(tmpdir, '.hermes')
    os.makedirs(config_dir)
    config_path = os.path.join(config_dir, 'config.yaml')

    if models is None:
        models = {
            'gpt-4': {},
            'gpt-3.5-turbo': {},
            'claude-3-opus': {},
        }

    config = {
        'model': {'default': 'gpt-4'},
        'providers': {
            'openai': {
                'api': 'https://api.openai.com/v1',
                'models': models,
                'default_model': 'gpt-4',
            },
            'anthropic': {
                'api': 'https://api.anthropic.com/v1',
                'models': {'claude-3-opus': {}, 'claude-3-sonnet': {}},
                'default_model': 'claude-3-opus',
            },
            'deepseek': {
                'api': 'https://api.deepseek.com/v1',
                'models': {'deepseek-v4-pro': {}, 'deepseek-v4-flash': {}},
                'default_model': 'deepseek-v4-pro',
            },
        },
    }

    with open(config_path, 'w') as f:
        yaml.dump(config, f)

    routing_dir = os.path.join(tmpdir, '.hermes-proxy')
    os.makedirs(routing_dir)
    routing_path = os.path.join(routing_dir, 'routing-mode.json')
    with open(routing_path, 'w') as f:
        json.dump({'mode': 'codex'}, f)

    return config_path, routing_path


class TestHermesE2EHealth:
    """E2E: GET /health — full pipeline from HTTP request to response."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'codex'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_e2e_health_full_pipeline(self):
        """Full pipeline: HTTP GET -> Flask router -> handler -> JSON response."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/health')

        assert response.status_code == 200
        json_data = response.get_json()
        assert json_data['status'] == 'healthy'
        # uptime is a float (Unix timestamp)
        assert isinstance(json_data['uptime'], (int, float))
        assert json_data['uptime'] > 0

    def test_e2e_health_content_type(self):
        """Response must have correct Content-Type header."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/health')
        assert 'application/json' in response.content_type


class TestHermesE2EModelsEndpoint:
    """E2E: GET /v1/models — verify OpenAI-format compliance."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'codex'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_e2e_models_format_compliance(self):
        """Response must be valid OpenAI /v1/models format."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')

        assert response.status_code == 200
        json_data = response.get_json()

        # Must be dict with 'data' key (OpenAI format)
        assert 'data' in json_data
        assert isinstance(json_data['data'], list)
        assert len(json_data['data']) > 0

        # Each item must have id, object, owned_by
        for model in json_data['data']:
            assert 'id' in model
            assert model['object'] == 'model'
            assert 'owned_by' in model

    def test_e2e_models_contains_all_providers(self):
        """All configured providers must appear in the models list."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        json_data = response.get_json()

        owned_by = {m['owned_by'] for m in json_data['data']}
        assert 'openai' in owned_by
        assert 'anthropic' in owned_by
        assert 'deepseek' in owned_by

    def test_e2e_models_deepseek_specific(self):
        """DeepSeek models must be present with correct IDs."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        json_data = response.get_json()

        ids = {m['id'] for m in json_data['data']}
        assert 'deepseek-v4-pro' in ids
        assert 'deepseek-v4-flash' in ids


class TestHermesE2ERoutingMode:
    """E2E: /api/routing-mode GET + POST — full CRUD cycle."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'codex'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_e2e_routing_mode_get_default(self):
        """GET returns current mode from in-memory state."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/routing-mode')
        assert response.status_code == 200
        assert response.get_json()['mode'] == 'codex'

    def test_e2e_routing_mode_set_and_verify_persistence(self):
        """POST updates mode AND persists to file (disk round-trip)."""
        client = self.proxy.app.test_client(self.proxy)

        # Set to 'config'
        r1 = client.post('/api/set-routing-mode', json={'mode': 'config'})
        assert r1.status_code == 200
        assert r1.get_json()['success'] is True

        # Verify in-memory
        assert self.proxy.routing_mode == 'config'

        # Verify persisted to disk
        with open(self.routing_path) as f:
            disk_data = json.load(f)
        assert disk_data['mode'] == 'config'

        # Restart: simulate process restart, reload from disk
        self.proxy.routing_mode = 'codex'  # reset
        self.proxy.load_routing_mode()  # re-read from file
        assert self.proxy.routing_mode == 'config'

    def test_e2e_routing_mode_invalid_rejected(self):
        """Invalid mode values are rejected with 400 and no disk write."""
        client = self.proxy.app.test_client(self.proxy)
        r = client.post('/api/set-routing-mode', json={'mode': 'invalid'})
        assert r.status_code == 400
        assert self.proxy.routing_mode == 'codex'  # unchanged


class TestHermesE2ESwitchModel:
    """E2E: /api/switch-model — config file round-trip verification."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'config'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_e2e_switch_and_verify_config_update(self):
        """Switch model → config file actually updates on disk."""
        client = self.proxy.app.test_client(self.proxy)

        with open(self.config_path) as f:
            initial = f.read()
        assert 'gpt-4' in initial

        r = client.post('/api/switch-model', json={'model': 'claude-3-opus'})
        assert r.status_code == 200
        assert r.get_json()['success'] is True

        # Verify disk was updated
        with open(self.config_path) as f:
            updated = f.read()
        assert 'claude-3-opus' in updated

        # Verify in-memory also updated
        assert self.proxy.get_current_model(self.proxy.parse_config_yaml(self.config_path)) == 'claude-3-opus'

    def test_e2e_switch_invalid_model(self):
        """Switch to non-existent model returns 400 and does NOT touch disk."""
        client = self.proxy.app.test_client(self.proxy)

        with open(self.config_path) as f:
            before = f.read()

        r = client.post('/api/switch-model', json={'model': 'nonexistent-model-xyz'})
        assert r.status_code == 400
        assert r.get_json()['success'] is False

        with open(self.config_path) as f:
            after = f.read()
        assert before == after  # disk unchanged


class TestHermesE2EProviders:
    """E2E: /api/providers CRUD — simulate add + list + delete cycle."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'codex'
        proxy_mod.switch_history.clear()
        # Clear any existing providers from prior runs
        proxy_mod.providers = []
        self.proxy = proxy_mod

    def test_e2e_add_provider_and_list(self):
        """Add a provider via POST, then verify it appears in GET /api/providers."""
        client = self.proxy.app.test_client(self.proxy)

        # POST new provider
        r = client.post('/api/providers', json={
            'name': 'TestProvider',
            'provider_id': 'test-provider',
            'api_key': 'test-key-123',
            'base_url': 'https://test.example.com/v1',
            'models': ['test-model-1', 'test-model-2'],
        })
        assert r.status_code == 200
        assert r.get_json()['success'] is True

        # GET providers and verify
        r2 = client.get('/api/providers')
        assert r2.status_code == 200
        providers = r2.get_json()['providers']
        # providers is a list of dicts
        assert isinstance(providers, list)
        names = [p['name'] for p in providers]
        assert 'TestProvider' in names

        # Verify the new provider has correct fields
        new_prov = [p for p in providers if p['name'] == 'TestProvider'][0]
        assert new_prov['base_url'] == 'https://test.example.com/v1'
        # api_key is masked on retrieval: first 4 chars + '****'
        assert new_prov['api_key'] == 'test****'
        # models are NOT stored in provider record (separate concept)
        assert 'models' not in new_prov
        assert 'id' in new_prov  # auto-generated UUID

    def test_e2e_delete_provider(self):
        """Delete a provider and verify it no longer appears."""
        client = self.proxy.app.test_client(self.proxy)

        # First add one
        r_add = client.post('/api/providers', json={
            'name': 'ToDelete',
            'provider_id': 'to-delete',
            'api_key': 'key',
            'base_url': 'https://del.example.com/v1',
            'models': ['m1'],
        })
        assert r_add.status_code == 200

        # Get the newly added provider's ID
        r_list = client.get('/api/providers')
        providers = r_list.get_json()['providers']
        to_delete = [p for p in providers if p['name'] == 'ToDelete'][0]
        provider_id = to_delete['id']

        # Then delete by ID
        r = client.delete(f'/api/providers/{provider_id}')
        assert r.status_code == 200
        assert r.get_json()['success'] is True

        # Verify it's gone
        r2 = client.get('/api/providers')
        names = [p['name'] for p in r2.get_json()['providers']]
        assert 'ToDelete' not in names


class TestHermesE2EHistory:
    """E2E: /api/history — switch triggers history record."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'config'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_e2e_switch_creates_history_entry(self):
        """Switch model → history endpoint reflects the change."""
        client = self.proxy.app.test_client(self.proxy)

        # Initial: empty history
        r0 = client.get('/api/history')
        assert r0.get_json()['history'] == []

        # Switch
        r1 = client.post('/api/switch-model', json={'model': 'gpt-4'})
        assert r1.status_code == 200

        # History should have one entry
        r2 = client.get('/api/history')
        history = r2.get_json()['history']
        assert len(history) == 1
        # Action is Chinese '切换模型' per actual API
        assert history[0]['action'] == '切换模型'
        assert history[0]['success'] is True

    def test_e2e_clear_history_removes_entries(self):
        """Clear history endpoint empties the list."""
        client = self.proxy.app.test_client(self.proxy)

        # Add entries via switches
        client.post('/api/switch-model', json={'model': 'gpt-4'})
        client.post('/api/switch-model', json={'model': 'claude-3-opus'})

        r_before = client.get('/api/history')
        assert len(r_before.get_json()['history']) == 2

        # Clear
        r_clear = client.post('/api/clear-history')
        assert r_clear.status_code == 200
        assert r_clear.get_json()['success'] is True

        r_after = client.get('/api/history')
        assert r_after.get_json()['history'] == []
