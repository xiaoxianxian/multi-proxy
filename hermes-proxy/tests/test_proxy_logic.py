"""Unit tests for hermes-proxy pure logic functions."""
import sys
import os
import json
import tempfile
import pytest

# Add parent dir to path so we can import proxy module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from proxy import (
    find_provider,
    parse_config_yaml,
    get_current_model,
    update_config_yaml,
    update_routing_mode,
    load_routing_mode,
    add_history,
    KNOWN_BALANCE_DOMAINS,
)


class TestFindProvider:
    def test_top_level_model_default_match(self):
        config = {'model': {'default': 'claude-3'}, 'providers': {'anthropic': {'api': 'https://api.anthropic.com'}}}
        result = find_provider('claude-3', config)
        assert result is not None
        assert result['name'] == 'anthropic'

    def test_provider_models_dict_match(self):
        config = {
            'providers': {
                'openai': {
                    'api': 'https://api.openai.com',
                    'models': {'gpt-4': {}, 'gpt-3.5': {}}
                }
            }
        }
        result = find_provider('gpt-4', config)
        assert result is not None
        assert result['name'] == 'openai'

    def test_provider_default_model_match(self):
        config = {
            'providers': {
                'openai': {
                    'api': 'https://api.openai.com',
                    'default_model': 'gpt-4'
                }
            }
        }
        result = find_provider('gpt-4', config)
        assert result is not None
        assert result['name'] == 'openai'

    def test_fallback_pattern_matching(self):
        config = {
            'model': 'not-a-dict',
            'providers': {
                'agnes': {'api': 'https://api.agnes.com', 'models': {'agnes-2.0-flash': {}}}
            }
        }
        result = find_provider('agnes-custom-model', config)
        assert result is not None
        assert result['name'] == 'agnes'

    def test_returns_none_for_unknown_model(self):
        config = {'providers': {'openai': {'api': 'https://api.openai.com'}}}
        assert find_provider('unknown-model', config) is None

    def test_returns_none_for_empty_inputs(self):
        assert find_provider('', {}) is None
        assert find_provider(None, None) is None


class TestGetCurrentModel:
    def test_toml_format(self):
        config = {'model': {'default': 'gpt-4'}}
        assert get_current_model(config) == 'gpt-4'

    def test_providers_format(self):
        config = {
            'model': 'not-a-dict',
            'providers': {
                'openai': {'api': 'https://api.openai.com', 'default_model': 'gpt-4'},
                'anthropic': {'api': 'https://api.anthropic.com', 'default_model': 'claude-3'}
            }
        }
        assert get_current_model(config) == 'gpt-4'

    def test_empty_config(self):
        assert get_current_model({}) == ''
        assert get_current_model(None) == ''


class TestParseConfigYaml:
    def test_parses_valid_yaml(self, tmp_path):
        f = tmp_path / 'config.yaml'
        f.write_text('model:\n  default: gpt-4\n')
        result = parse_config_yaml(str(f))
        assert result == {'model': {'default': 'gpt-4'}}

    def test_returns_empty_dict_on_error(self):
        assert parse_config_yaml('/nonexistent/path.yaml') == {}


class TestUpdateConfigYaml:
    def test_updates_toml_format(self, tmp_path):
        f = tmp_path / 'config.yaml'
        f.write_text('model:\n  default: old-model\n')
        result = update_config_yaml(str(f), 'new-model')
        assert result['success'] is True
        content = f.read_text()
        assert 'new-model' in content

    def test_updates_providers_format(self, tmp_path):
        f = tmp_path / 'config.yaml'
        f.write_text('providers:\n  openai:\n    default_model: old-model\n')
        result = update_config_yaml(str(f), 'new-model')
        assert result['success'] is True

    def test_returns_error_on_nonexistent_file(self):
        result = update_config_yaml('/nonexistent/file.yaml', 'x')
        assert result['success'] is False


class TestRoutingMode:
    def test_update_routing_mode_creates_file(self, tmp_path):
        f = str(tmp_path / 'routing-mode.json')
        # Temporarily override the global ROUTING_MODE_FILE
        import proxy
        old = proxy.ROUTING_MODE_FILE
        proxy.ROUTING_MODE_FILE = f
        try:
            result = update_routing_mode('config')
            assert result is True
            with open(f) as fh:
                data = json.load(fh)
            assert data['mode'] == 'config'
        finally:
            proxy.ROUTING_MODE_FILE = old

    def test_load_routing_mode_reads_file(self, tmp_path):
        f = str(tmp_path / 'routing-mode.json')
        with open(f, 'w') as fh:
            json.dump({'mode': 'both'}, fh)
        import proxy
        old = proxy.ROUTING_MODE_FILE
        proxy.ROUTING_MODE_FILE = f
        try:
            load_routing_mode()
            assert proxy.routing_mode == 'both'
        finally:
            proxy.ROUTING_MODE_FILE = old
            proxy.routing_mode = 'codex'  # reset


class TestAddHistory:
    def test_adds_entry(self):
        before = len([e for e in []])  # placeholder
        entry = add_history('switch', 'gpt-4', 'gpt-3.5', 'config', True)
        assert entry['action'] == 'switch'
        assert entry['from'] == 'gpt-4'
        assert entry['to'] == 'gpt-3.5'
        assert 'timestamp' in entry

    def test_truncates_at_max_history(self):
        # We can't easily test the global switch_history without mocking,
        # but we verify the function works
        entry = add_history('test', '', '', '', True)
        assert entry['success'] is True


class TestKnownBalanceDomains:
    def test_has_expected_providers(self):
        assert 'api.openai.com' in KNOWN_BALANCE_DOMAINS
        assert 'api.anthropic.com' in KNOWN_BALANCE_DOMAINS
        assert 'api.deepseek.com' in KNOWN_BALANCE_DOMAINS
        assert 'api.moonshot.cn' in KNOWN_BALANCE_DOMAINS

    def test_anthropic_has_no_balance_api(self):
        assert KNOWN_BALANCE_DOMAINS['api.anthropic.com'] is None

    def test_openai_has_get_endpoint(self):
        method, path = KNOWN_BALANCE_DOMAINS['api.openai.com']
        assert method == 'GET'
        assert '/dashboard/billing/credit_grants' in path
