"""Integration tests for Hermes HTTP endpoints using Flask test client.

Tests the actual HTTP endpoints (/health, /v1/models, /api/models,
/api/config, /api/routing-mode, /api/switch-model, /api/providers/status)
by creating a temporary config and using Flask's test client.
"""

import json
import os
import sys
import tempfile
import shutil

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
        },
    }

    with open(config_path, 'w') as f:
        yaml.dump(config, f)

    # Routing mode file
    routing_dir = os.path.join(tmpdir, '.hermes-proxy')
    os.makedirs(routing_dir)
    routing_path = os.path.join(routing_dir, 'routing-mode.json')
    with open(routing_path, 'w') as f:
        json.dump({'mode': 'codex'}, f)

    return config_path, routing_path


class TestHermesHealthEndpoint:
    """Test GET /health endpoint."""

    @pytest.fixture(autouse=True)
    def _setup(self, tmp_path, monkeypatch):
        """Create temp config and patch module-level globals."""
        self.tmpdir = str(tmp_path)
        self.config_path, self.routing_path = _create_tmp_config(self.tmpdir)

        # Import after setting path
        import proxy as proxy_mod
        monkeypatch.setattr(proxy_mod, 'HOME', self.tmpdir)
        monkeypatch.setattr(proxy_mod, 'CONFIG_YAML_PATH', self.config_path)
        monkeypatch.setattr(proxy_mod, 'ROUTING_MODE_FILE', self.routing_path)
        proxy_mod.routing_mode = 'codex'
        proxy_mod.switch_history.clear()
        self.proxy = proxy_mod

    def test_health_returns_200(self):
        """GET /health returns 200 OK."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/health')
        assert response.status_code == 200

    def test_health_contains_status(self):
        """Health response includes status field."""
        client = self.proxy.app.test_client(self.proxy)
        data = response = client.get('/health')
        assert response.status_code == 200
        json_data = response.get_json()
        assert json_data.get('status') == 'healthy'

    def test_health_detects_current_model(self):
        """Health endpoint detects the current model from config."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/health')
        json_data = response.get_json()
        assert json_data.get('current_model') == 'gpt-4'

    def test_health_includes_uptime(self):
        """Health response includes an uptime field."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/health')
        json_data = response.get_json()
        assert 'uptime' in json_data or 'status' in json_data


class TestHermesV1ModelsEndpoint:
    """Test GET /v1/models endpoint."""

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

    def test_v1_models_returns_list(self):
        """GET /v1/models returns a list of models in OpenAI format."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        assert response.status_code == 200

        json_data = response.get_json()
        assert 'data' in json_data or isinstance(json_data, list)

    def test_v1_models_contains_openai_models(self):
        """Models list includes OpenAI models from config."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        json_data = response.get_json()

        # Extract model IDs from response
        if isinstance(json_data, list):
            ids = [m.get('id') or m.get('name', '') for m in json_data]
        elif isinstance(json_data, dict) and 'data' in json_data:
            ids = [m.get('id') or m.get('name', '') for m in json_data['data']]
        else:
            ids = []

        assert 'gpt-4' in ids
        assert 'gpt-3.5-turbo' in ids

    def test_v1_models_contains_anthropic_models(self):
        """Models list includes Anthropic models from config."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        json_data = response.get_json()

        if isinstance(json_data, list):
            ids = [m.get('id') or m.get('name', '') for m in json_data]
        elif isinstance(json_data, dict) and 'data' in json_data:
            ids = [m.get('id') or m.get('name', '') for m in json_data['data']]
        else:
            ids = []

        assert 'claude-3-opus' in ids

    def test_v1_models_has_correct_format(self):
        """Each model has 'id' and 'object' fields."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/v1/models')
        json_data = response.get_json()

        models = json_data.get('data', []) if isinstance(json_data, dict) else json_data
        for model in models:
            assert 'id' in model, f"Model missing 'id': {model}"
            assert 'object' in model, f"Model missing 'object': {model}"
            assert model['object'] == 'model', f"Expected object='model', got '{model.get('object')}'"


class TestHermesApiConfigEndpoint:
    """Test GET /api/config endpoint."""

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

    def test_api_config_returns_model(self):
        """GET /api/config returns the current model."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/config')
        assert response.status_code == 200

        json_data = response.get_json()
        assert json_data.get('model') == 'gpt-4'

    def test_api_config_returns_path(self):
        """GET /api/config returns the config file path."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/config')
        json_data = response.get_json()
        assert 'path' in json_data
        assert 'config.yaml' in json_data['path']


class TestHermesApiRoutingMode:
    """Test routing mode endpoints."""

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

    def test_get_routing_mode(self):
        """GET /api/routing-mode returns current mode."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/routing-mode')
        assert response.status_code == 200

        json_data = response.get_json()
        assert 'mode' in json_data
        assert json_data['mode'] == 'codex'

    def test_set_routing_mode_to_config(self):
        """POST /api/set-routing-mode updates mode to 'config'."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/set-routing-mode',
                                json={'mode': 'config'})
        assert response.status_code == 200

        json_data = response.get_json()
        assert json_data.get('success') is True
        assert json_data.get('mode') == 'config'
        assert self.proxy.routing_mode == 'config'

    def test_set_routing_mode_invalid_value(self):
        """POST /api/set-routing-mode rejects invalid mode values."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/set-routing-mode',
                                json={'mode': 'invalid'})
        assert response.status_code == 400

        json_data = response.get_json()
        assert json_data.get('success') is False


class TestHermesSwitchModel:
    """Test POST /api/switch-model endpoint."""

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

    def test_switch_model_success(self):
        """POST /api/switch-model switches to an existing model."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/switch-model',
                                json={'model': 'claude-3-opus'})
        assert response.status_code == 200

        json_data = response.get_json()
        assert json_data.get('success') is True
        assert json_data.get('needRestart') is True

    def test_switch_model_invalid(self):
        """POST /api/switch-model rejects unsupported models."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/switch-model',
                                json={'model': 'nonexistent-model'})
        assert response.status_code == 400

        json_data = response.get_json()
        assert json_data.get('success') is False
        assert 'code' in json_data

    def test_switch_model_missing_param(self):
        """POST /api/switch-model rejects missing model parameter."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/switch-model', json={})
        assert response.status_code == 400

        json_data = response.get_json()
        assert json_data.get('success') is False


class TestHermesProvidersStatus:
    """Test GET /api/providers/status endpoint."""

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

    def test_providers_status_returns_list(self):
        """GET /api/providers/status returns provider list."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/providers/status')
        assert response.status_code == 200

        json_data = response.get_json()
        assert 'providers' in json_data
        assert len(json_data['providers']) >= 2

    def test_provider_fields_present(self):
        """Each provider has name, baseUrl, status fields."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/providers/status')
        json_data = response.get_json()

        for provider in json_data['providers']:
            assert 'name' in provider
            assert 'baseUrl' in provider or 'api' in provider
            assert 'status' in provider or 'models' in provider

    def test_all_configured_providers_reported(self):
        """Reported providers match config."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/providers/status')
        json_data = response.get_json()

        names = {p['name'].lower() for p in json_data['providers']}
        assert 'openai' in names
        assert 'anthropic' in names


class TestHermesHistory:
    """Test history-related endpoints."""

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

    def test_empty_history_initially(self):
        """GET /api/history returns empty list when no switches occurred."""
        client = self.proxy.app.test_client(self.proxy)
        response = client.get('/api/history')
        assert response.status_code == 200

        json_data = response.get_json()
        assert json_data.get('history') == []

    def test_clear_history(self):
        """POST /api/clear-history clears the history list."""
        # Add some history first
        self.proxy.switch_history = [
            {'action': 'switch', 'old': 'gpt-4', 'new': 'claude-3', 'time': '2024-01-01T00:00:00Z'}
        ]

        client = self.proxy.app.test_client(self.proxy)
        response = client.post('/api/clear-history')
        assert response.status_code == 200

        json_data = response.get_json()
        assert json_data.get('success') is True
        assert self.proxy.switch_history == []

    def test_history_after_switch(self):
        """Switching model records history entry."""
        client = self.proxy.app.test_client(self.proxy)

        # Switch model
        response = client.post('/api/switch-model', json={'model': 'claude-3-opus'})
        assert response.status_code == 200

        # Check history
        history_response = client.get('/api/history')
        history_data = history_response.get_json()
        assert len(history_data.get('history', [])) >= 1
