#!/usr/bin/env python3
"""
Hermes Multi-Model Proxy
A Python HTTP proxy server that manages multiple AI models for Hermes Agent.
Listens on port 18793 by default.
"""

import os
import sys
import json
import time
import logging
from datetime import datetime
from pathlib import Path
from functools import wraps

import yaml
import requests
from flask import Flask, request, jsonify, Response, stream_with_context

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False

# Configuration
PORT = int(os.environ.get('PORT', 18793))
HOME = os.environ.get('HOME', str(Path.home()))
CONFIG_YAML_PATH = os.path.join(HOME, '.hermes', 'config.yaml')
ROUTING_MODE_FILE = os.path.join(HOME, '.hermes-proxy', 'routing-mode.json')

# In-memory switch history
switch_history = []
MAX_HISTORY = 50

# Routing mode
routing_mode = 'codex'  # 'codex' | 'config' | 'both'


def load_routing_mode():
    """Load routing mode from file."""
    global routing_mode
    try:
        if os.path.exists(ROUTING_MODE_FILE):
            with open(ROUTING_MODE_FILE, 'r') as f:
                data = json.load(f)
                if data.get('mode') in ['codex', 'config', 'both']:
                    routing_mode = data['mode']
    except Exception as e:
        logger.warning(f"Failed to load routing mode: {e}")
        routing_mode = 'codex'


def update_routing_mode(mode):
    """Update routing mode to file using atomic rename to prevent race conditions."""
    global routing_mode
    try:
        os.makedirs(os.path.dirname(ROUTING_MODE_FILE), exist_ok=True)
        tmp_file = ROUTING_MODE_FILE + '.tmp'
        with open(tmp_file, 'w') as f:
            json.dump({'mode': mode}, f, indent=2)
        os.replace(tmp_file, ROUTING_MODE_FILE)
        routing_mode = mode
        logger.info(f"Routing mode updated to: {mode}")
        return True
    except Exception as e:
        # Clean up temp file on failure
        try:
            os.unlink(ROUTING_MODE_FILE + '.tmp')
        except OSError:
            pass
        logger.error(f"Failed to update routing mode: {e}")
        return False


def find_config_yaml():
    """Find the config.yaml file."""
    candidates = [
        os.path.join(HOME, '.hermes', 'config.yaml'),
        os.path.join(HOME, 'Library', 'Containers', 'app.nousresearch.hermes', 'Data', '.hermes', 'config.yaml'),
        os.path.join(HOME, '.hermes', 'config.yml'),
    ]

    for candidate in candidates:
        if os.path.exists(candidate):
            logger.info(f"Found config file: {candidate}")
            return candidate

    return candidates[0]  # Return first candidate as default


def parse_config_yaml(file_path):
    """Parse YAML config file."""
    try:
        with open(file_path, 'r') as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"Failed to parse config: {e}")
        return {}


def get_current_model(config_data):
    """Extract current model from config data."""
    if not config_data:
        return ''

    # Try TOML format first
    model = config_data.get('model', {})
    if isinstance(model, dict):
        return model.get('default', '')

    # Try YAML format (nested structure)
    providers = config_data.get('providers', {})
    if providers:
        # Get first provider's default model
        for provider_name, provider_config in providers.items():
            if isinstance(provider_config, dict):
                default_model = provider_config.get('default_model', '')
                if default_model:
                    return default_model

    return ''


def update_config_yaml(file_path, new_model):
    """Update the model in config.yaml."""
    try:
        with open(file_path, 'r') as f:
            config = yaml.safe_load(f)

        if not config:
            config = {}

        # Update model.default or providers[*].default_model
        if 'model' in config and isinstance(config['model'], dict):
            config['model']['default'] = new_model
        elif 'providers' in config and isinstance(config['providers'], dict):
            for provider_name, provider_config in config['providers'].items():
                if isinstance(provider_config, dict) and 'default_model' in provider_config:
                    provider_config['default_model'] = new_model
                    break

        with open(file_path, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

        return {'success': True, 'message': f'Updated config to model: {new_model}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def find_provider(model_name, config_data):
    """Find the provider for a given model.

    Priority:
    1. Top-level model.default (the actual active model)
    2. Provider's models dict
    3. Provider's default_model
    4. Fallback: match by model name patterns (e.g., agnes-* → agnes provider)
    """
    if not model_name or not config_data:
        return None

    providers = config_data.get('providers', {})

    # 1. Check top-level model.default — this is the actual active model
    top_model = config_data.get('model', {})
    if isinstance(top_model, dict):
        top_default = top_model.get('default', '')
        if top_default == model_name:
            for pname, pconfig in providers.items():
                if isinstance(pconfig, dict) and pconfig.get('api'):
                    return {
                        'name': pname,
                        'api': pconfig['api'],
                        'models': [model_name]
                    }
            return None

    # 2. Check provider models dict
    if providers:
        for provider_name, provider_config in providers.items():
            if isinstance(provider_config, dict):
                models = provider_config.get('models', {})
                if isinstance(models, dict) and model_name in models:
                    return {
                        'name': provider_name,
                        'api': provider_config.get('api', ''),
                        'models': list(models.keys())
                    }

                # 3. Check provider default_model
                if provider_config.get('default_model') == model_name:
                    return {
                        'name': provider_name,
                        'api': provider_config.get('api', ''),
                        'models': [model_name]
                    }

    # 4. Fallback: match by model name patterns
    if providers:
        for provider_name, provider_config in providers.items():
            if isinstance(provider_config, dict) and provider_config.get('api'):
                # agnes-* → agnes provider
                if model_name.lower().startswith(provider_name.lower()):
                    return {
                        'name': provider_name,
                        'api': provider_config['api'],
                        'models': [model_name]
                    }

    return None


def add_history(action, from_model, to_model, mode, success):
    """Add entry to switch history."""
    entry = {
        'timestamp': int(time.time() * 1000),
        'action': action,
        'from': from_model,
        'to': to_model,
        'mode': mode,
        'success': success
    }
    switch_history.append(entry)
    if len(switch_history) > MAX_HISTORY:
        switch_history.pop(0)
    return entry


# API Routes

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}
    current_model = get_current_model(config_data)

    return jsonify({
        'status': 'healthy',
        'uptime': time.time(),
        'current_model': current_model,
        'config_path': config_path
    })


@app.route('/v1/models', methods=['GET'])
def list_models():
    """List available models."""
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}

    models = []
    providers = config_data.get('providers', {})

    if providers:
        for provider_name, provider_config in providers.items():
            if isinstance(provider_config, dict):
                provider_models = provider_config.get('models', {})
                if isinstance(provider_models, dict):
                    for model_name in provider_models.keys():
                        models.append({
                            'id': model_name,
                            'object': 'model',
                            'created': int(time.time()),
                            'owned_by': provider_name
                        })

    return jsonify({
        'object': 'list',
        'data': models
    })


@app.route('/api/config', methods=['GET'])
def get_config():
    """Get current configuration."""
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}
    current_model = get_current_model(config_data)

    return jsonify({
        'model': current_model,
        'path': config_path,
        'raw': config_data
    })


@app.route('/api/routing-mode', methods=['GET'])
def get_routing_mode():
    """Get current routing mode."""
    load_routing_mode()
    return jsonify({'mode': routing_mode})


@app.route('/api/set-routing-mode', methods=['POST'])
def set_routing_mode():
    """Set routing mode."""
    data = request.get_json()
    mode = data.get('mode') if data else None

    if mode not in ['codex', 'config', 'both']:
        return jsonify({'success': False, 'error': 'Invalid mode', 'code': 'INVALID_MODE'}), 400

    if update_routing_mode(mode):
        return jsonify({'success': True, 'mode': mode})
    else:
        return jsonify({'success': False, 'error': 'Failed to update routing mode'}), 500


@app.route('/api/providers/status', methods=['GET'])
def get_providers_status():
    """Get provider status."""
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}

    providers = []
    provider_configs = config_data.get('providers', {})

    if provider_configs:
        for name, config in provider_configs.items():
            if isinstance(config, dict):
                api_url = config.get('api', '')
                # Check if API key is configured
                status = 'online' if api_url else 'offline'
                providers.append({
                    'name': name,
                    'baseUrl': api_url,
                    'status': status,
                    'models': list(config.get('models', {}).keys()) if isinstance(config.get('models'), dict) else []
                })

    return jsonify({'providers': providers})


KNOWN_BALANCE_DOMAINS = {
    'api.openai.com': ('GET', '/dashboard/billing/credit_grants'),
    'api.anthropic.com': None,  # No public balance API
    'api.deepseek.com': ('GET', '/user/info'),
    'api.moonshot.cn': ('GET', '/user/info'),
}


@app.route('/api/balances', methods=['GET'])
def get_balances():
    """Get account balances (simplified - actual implementation depends on provider APIs)."""
    balances = {}
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}

    providers = config_data.get('providers', {})
    for name, config in providers.items():
        if not isinstance(config, dict):
            balances[name] = '不可查询'
            continue
        api_url = config.get('api', '')
        if not api_url:
            balances[name] = '不可查询'
            continue
        # Extract hostname and check against known providers
        from urllib.parse import urlparse
        try:
            parsed = urlparse(api_url)
            host = parsed.hostname or ''
        except Exception:
            host = ''
        if host in KNOWN_BALANCE_DOMAINS:
            endpoint = KNOWN_BALANCE_DOMAINS[host]
            if endpoint is None:
                balances[name] = '无公开余额API'
            else:
                method, path = endpoint
                try:
                    url = f"{api_url.rstrip('/')}{path}"
                    resp = requests.get(url, timeout=5)
                    if resp.ok:
                        data = resp.json()
                        balances[name] = data.get('balance', data.get('amount', data.get('totalAmount', '未知')))
                    else:
                        balances[name] = f'查询失败 (HTTP {resp.status_code})'
                except Exception as e:
                    balances[name] = f'查询失败: {str(e)}'
        else:
            balances[name] = '不可查询'

    return jsonify({'balances': balances})


@app.route('/api/history', methods=['GET'])
def get_history():
    """Get switch history."""
    return jsonify({
        'history': switch_history[:20][::-1]  # Last 20 entries, reversed
    })


@app.route('/api/switch-model', methods=['POST'])
def switch_model():
    """Switch to a different model."""
    data = request.get_json()
    if not data or 'model' not in data:
        return jsonify({'success': False, 'error': 'Missing model parameter', 'code': 'MISSING_MODEL'}), 400

    new_model = data['model']
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}

    old_model = get_current_model(config_data)

    # Validate model exists
    provider = find_provider(new_model, config_data)
    if not provider:
        return jsonify({'success': False, 'error': f'Unsupported model: {new_model}', 'code': 'UNSUPPORTED_MODEL'}), 400

    # Update config
    result = update_config_yaml(config_path, new_model)
    if not result['success']:
        return jsonify({'success': False, 'error': result['error'], 'code': 'CONFIG_UPDATE_FAILED'}), 500

    # Auto-switch to config routing mode
    update_routing_mode('config')

    # Record history
    add_history('切换模型', old_model, new_model, 'config', True)

    logger.info(f"[ADMIN] Model switched: {old_model} → {new_model}")

    return jsonify({
        'success': True,
        'message': f'Successfully switched to {new_model}, routing mode set to config',
        'oldModel': old_model,
        'newModel': new_model,
        'needRestart': True
    })


@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    """Test connection to a model's provider."""
    data = request.get_json()
    if not data or 'model' not in data:
        return jsonify({'success': False, 'error': 'Missing model parameter', 'code': 'MISSING_MODEL'}), 400

    model = data['model']
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}

    provider = find_provider(model, config_data)
    if not provider:
        return jsonify({'success': False, 'error': f'Unsupported model: {model}'}), 400

    try:
        # Try to fetch models from provider API
        api_url = provider['api']
        if api_url:
            response = requests.get(f"{api_url}/models", timeout=10)
            if response.ok:
                return jsonify({'success': True, 'message': 'Connection successful'})
            else:
                return jsonify({'success': False, 'error': f'HTTP {response.status_code}', 'code': 'UPSTREAM_HTTP_ERROR'}), 200
        else:
            return jsonify({'success': False, 'error': 'No API URL configured', 'code': 'NO_API_URL'}), 200

    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'code': 'CONNECTION_FAILED'})


@app.route('/api/clear-history', methods=['POST'])
def clear_history():
    """Clear switch history."""
    global switch_history
    switch_history = []
    return jsonify({'success': True})


# Main entry point
if __name__ == '__main__':
    logger.info(f"Hermes Multi-Model Proxy starting on port {PORT}")
    logger.info(f"Config path: {find_config_yaml()}")

    # Load initial routing mode
    load_routing_mode()

    app.run(host='127.0.0.1', port=PORT, debug=False)
