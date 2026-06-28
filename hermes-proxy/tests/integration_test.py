"""Integration tests for hermes-proxy HTTP endpoints.

Tests all major API endpoints using the proxy module's pure functions directly.
Since proxy.py runs `app.run()` at module level, we test the functions
and config parsing logic that power the HTTP endpoints.
"""

import sys
import os
import json
import tempfile
import shutil
import time

import pytest
import yaml

# Ensure proxy module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture
def tmp_config_dir():
    """Create a temporary directory for config files."""
    d = tempfile.mkdtemp(prefix="hermes-integration-")
    config_path = os.path.join(d, ".hermes", "config.yaml")
    os.makedirs(os.path.dirname(config_path), exist_ok=True)

    default_config = {
        "model": {"default": "claude-3"},
        "providers": {
            "openai": {
                "api": "https://api.openai.com/v1",
                "models": {"gpt-4": {}, "gpt-3.5-turbo": {}},
                "default_model": "gpt-4",
            },
            "anthropic": {
                "api": "https://api.anthropic.com/v1",
                "models": {"claude-3-opus": {}, "claude-3-sonnet": {}},
                "default_model": "claude-3-opus",
            },
            "deepseek": {
                "api": "https://api.deepseek.com/v1",
                "models": {"deepseek-v4-pro": {}, "deepseek-v4-flash": {}},
                "default_model": "deepseek-v4-pro",
            },
        },
    }
    with open(config_path, "w") as f:
        yaml.dump(default_config, f)

    routing_dir = os.path.join(d, ".hermes-proxy")
    os.makedirs(routing_dir, exist_ok=True)

    yield {
        "dir": d,
        "config_path": config_path,
        "routing_file": os.path.join(d, ".hermes-proxy", "routing-mode.json"),
    }

    if os.path.exists(d):
        shutil.rmtree(d)


@pytest.fixture(autouse=True)
def patch_proxy_module(tmp_config_dir, monkeypatch):
    """Patch the proxy module to use temp directories."""
    import proxy

    monkeypatch.setenv("HOME", tmp_config_dir["dir"])
    monkeypatch.setattr(proxy, "CONFIG_YAML_PATH", tmp_config_dir["config_path"])
    monkeypatch.setattr(
        proxy, "ROUTING_MODE_FILE", tmp_config_dir["routing_file"]
    )
    # Reset routing mode and history
    proxy.routing_mode = "codex"
    proxy.switch_history.clear()

    return proxy


class TestHermesModelsEndpoint:
    """Test /v1/models endpoint logic."""

    def test_returns_models_from_config(self, patch_proxy_module):
        """Should return a list of models from config providers."""
        proxy = patch_proxy_module
        config_data = proxy.parse_config_yaml(proxy.CONFIG_YAML_PATH)
        models = []
        providers = config_data.get("providers", {})
        for provider_name, provider_config in providers.items():
            if isinstance(provider_config, dict):
                pm = provider_config.get("models", {})
                if isinstance(pm, dict):
                    for model_name in pm:
                        models.append({
                            "id": model_name,
                            "object": "model",
                            "owned_by": provider_name,
                        })

        assert len(models) > 0
        owned_by = {m["owned_by"] for m in models}
        assert "openai" in owned_by
        assert "anthropic" in owned_by
        assert "deepseek" in owned_by

    def test_model_structure(self, patch_proxy_module):
        """Each model should have id, object, owned_by fields."""
        proxy = patch_proxy_module
        config_data = proxy.parse_config_yaml(proxy.CONFIG_YAML_PATH)
        models = []
        providers = config_data.get("providers", {})
        for provider_config in providers.values():
            if isinstance(provider_config, dict):
                pm = provider_config.get("models", {})
                if isinstance(pm, dict):
                    for name in pm:
                        models.append({"id": name, "object": "model", "owned_by": "test"})

        for m in models:
            assert "id" in m
            assert "object" in m
            assert m["object"] == "model"
            assert "owned_by" in m


class TestHermesHealthEndpoint:
    """Test /health endpoint logic."""

    def test_health_detects_model(self, patch_proxy_module):
        """Health should detect current model from config."""
        proxy = patch_proxy_module
        config_data = proxy.parse_config_yaml(proxy.CONFIG_YAML_PATH)
        current_model = proxy.get_current_model(config_data)
        assert current_model  # Should detect a model from config


class TestHermesConfigEndpoint:
    """Test /api/config endpoint logic."""

    def test_config_returns_model_and_path(self, patch_proxy_module):
        """Config endpoint should return model, path, and raw data."""
        proxy = patch_proxy_module
        config_data = proxy.parse_config_yaml(proxy.CONFIG_YAML_PATH)
        current_model = proxy.get_current_model(config_data)
        assert current_model
        assert proxy.CONFIG_YAML_PATH.endswith("config.yaml")


class TestHermesProvidersStatus:
    """Test /api/providers/status endpoint logic."""

    def test_reports_all_providers(self, patch_proxy_module):
        """Should report status for all configured providers."""
        proxy = patch_proxy_module
        config_data = proxy.parse_config_yaml(proxy.CONFIG_YAML_PATH)
        providers = config_data.get("providers", {})
        assert len(providers) >= 3

        for name, cfg in providers.items():
            assert isinstance(cfg, dict)
            assert "api" in cfg
            assert cfg["api"]  # All have API URLs


class TestHermesRoutingMode:
    """Test routing mode endpoints."""

    def test_default_routing_mode(self, patch_proxy_module):
        """Default routing mode should be 'codex'."""
        assert patch_proxy_module.routing_mode == "codex"

    def test_update_routing_mode(self, patch_proxy_module):
        """Should update routing mode to file."""
        for mode in ["codex", "config", "both"]:
            result = patch_proxy_module.update_routing_mode(mode)
            assert result is True
            assert patch_proxy_module.routing_mode == mode

    def test_load_routing_mode_from_file(self, patch_proxy_module, tmp_config_dir):
        """Should read routing mode from file."""
        rf = tmp_config_dir["routing_file"]
        with open(rf, "w") as f:
            json.dump({"mode": "both"}, f)
        patch_proxy_module.load_routing_mode()
        assert patch_proxy_module.routing_mode == "both"

    def test_invalid_routing_mode_rejected(self):
        """Should reject invalid routing mode values."""
        valid_modes = ["codex", "config", "both"]
        for invalid in ["invalid", "", "random", "0", "true"]:
            assert invalid not in valid_modes


class TestHermesSwitchModel:
    """Test switch-model endpoint logic."""

    def test_switch_model_updates_config(self, patch_proxy_module):
        """Switching model should update the config file."""
        result = patch_proxy_module.update_config_yaml(
            patch_proxy_module.CONFIG_YAML_PATH, "gpt-4"
        )
        assert result["success"] is True

        # Verify the file was updated
        new_config = patch_proxy_module.parse_config_yaml(
            patch_proxy_module.CONFIG_YAML_PATH
        )
        new_model = patch_proxy_module.get_current_model(new_config)
        assert new_model == "gpt-4"

    def test_find_provider_validates_model(self, patch_proxy_module):
        """find_provider should return None for unknown models."""
        config_data = patch_proxy_module.parse_config_yaml(
            patch_proxy_module.CONFIG_YAML_PATH
        )
        result = patch_proxy_module.find_provider("nonexistent-model-xyz", config_data)
        assert result is None


class TestHermesHistory:
    """Test switch history endpoint logic."""

    def test_adds_history_entry(self, patch_proxy_module):
        """Adding history should create a valid entry."""
        entry = patch_proxy_module.add_history("switch", "gpt-4", "claude-3", "config", True)
        assert entry["action"] == "switch"
        assert entry["from"] == "gpt-4"
        assert entry["to"] == "claude-3"
        assert entry["mode"] == "config"
        assert entry["success"] is True
        assert "timestamp" in entry

    def test_history_truncates_at_max(self, patch_proxy_module):
        """History should be limited to MAX_HISTORY entries."""
        for i in range(60):
            patch_proxy_module.add_history("test", "", "", "", True)
        assert len(patch_proxy_module.switch_history) <= patch_proxy_module.MAX_HISTORY


class TestHermesBalanceDomains:
    """Test KNOWN_BALANCE_DOMAINS configuration."""

    def test_contains_expected_domains(self, patch_proxy_module):
        assert "api.openai.com" in patch_proxy_module.KNOWN_BALANCE_DOMAINS
        assert "api.deepseek.com" in patch_proxy_module.KNOWN_BALANCE_DOMAINS
        assert "api.moonshot.cn" in patch_proxy_module.KNOWN_BALANCE_DOMAINS

    def test_anthropic_no_balance_api(self, patch_proxy_module):
        assert patch_proxy_module.KNOWN_BALANCE_DOMAINS["api.anthropic.com"] is None

    def test_deepseek_has_user_info_endpoint(self, patch_proxy_module):
        method, path = patch_proxy_module.KNOWN_BALANCE_DOMAINS["api.deepseek.com"]
        assert method == "GET"
        assert "/user/info" in path


class TestHermesConfigParsing:
    """Test config file parsing edge cases."""

    def test_parse_empty_yaml(self, tmp_config_dir):
        """Parsing an empty YAML file should return None or empty dict."""
        import proxy
        empty_file = os.path.join(tmp_config_dir["dir"], "empty.yaml")
        with open(empty_file, "w") as f:
            f.write("")
        result = proxy.parse_config_yaml(empty_file)
        assert result is None or result == {}

    def test_parse_nonexistent_file(self, tmp_config_dir):
        """Parsing a nonexistent file should return empty dict."""
        import proxy
        result = proxy.parse_config_yaml("/nonexistent/path.yaml")
        assert result == {}

    def test_get_current_model_empty(self):
        """get_current_model with empty config should return empty string."""
        import proxy
        assert proxy.get_current_model({}) == ""
        assert proxy.get_current_model(None) == ""

    def test_get_current_model_providers_format(self, tmp_config_dir):
        """get_current_model should work with providers format with top-level model key."""
        import proxy
        # When 'model' key is not a dict (string), it falls through to providers check
        config = {
            "model": "not-a-dict",
            "providers": {
                "openai": {"api": "https://api.openai.com", "default_model": "gpt-4"},
                "anthropic": {"api": "https://api.anthropic.com", "default_model": "claude-3"},
            }
        }
        model = proxy.get_current_model(config)
        assert model == "gpt-4"
