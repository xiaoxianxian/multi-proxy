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
AUTH_TOKEN = os.environ.get('PROXY_AUTH_TOKEN', '')
CONFIG_YAML_PATH = os.path.join(HOME, '.hermes', 'config.yaml')
DATA_DIR = os.path.join(HOME, '.multi-proxy-manager')
ROUTING_MODE_FILE = os.path.join(DATA_DIR, 'routing-mode.json')
PROVIDERS_FILE = os.path.join(DATA_DIR, 'providers.json')

# ===== Auth Middleware =====
def require_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not AUTH_TOKEN:
            return f(*args, **kwargs)  # Auth disabled if no token set
        header_token = request.headers.get('x-proxy-auth')
        if header_token == AUTH_TOKEN:
            return f(*args, **kwargs)
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    return decorated_function

# In-memory switch history
switch_history = []
MAX_HISTORY = 50

# Routing mode
routing_mode = 'codex'  # 'codex' | 'config' | 'both'

# ===== Provider store =====
def load_providers():
    try:
        if os.path.exists(PROVIDERS_FILE):
            with open(PROVIDERS_FILE, 'r') as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
    except Exception:
        pass
    return []

def save_providers(providers):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        # P0-8: 原子写 —— 直接 open('w') 在进程崩溃/磁盘满时会留下半截
        # JSON，下次 load 解析失败静默返回空列表导致数据全丢。tmp+replace
        # 与 save_routing_mode 同模式，os.replace 是原子操作。
        tmp_file = PROVIDERS_FILE + '.tmp'
        # P1: 文件含明文 API Key，收紧权限到 0600
        with open(tmp_file, 'w') as f:
            json.dump(providers, f, indent=2)
        os.chmod(tmp_file, 0o600)
        os.replace(tmp_file, PROVIDERS_FILE)
    except Exception as e:
        try:
            os.unlink(PROVIDERS_FILE + '.tmp')
        except OSError:
            pass
        logger.error(f"Failed to save providers: {e}")

providers = load_providers()

def generate_id():
    # 与 codex-proxy generateId() 同构：prov_ + base36 毫秒时间戳(9位补零)
    # + '_' + 6位 base36 随机串。
    import random
    ts36 = _to_base36(int(time.time() * 1000)).rjust(9, '0')
    rand36 = ''.join(random.choice('0123456789abcdefghijklmnopqrstuvwxyz')
                     for _ in range(6))
    return 'prov_' + ts36 + '_' + rand36


def _to_base36(n):
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return ''.join(reversed(out))


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
        os.makedirs(DATA_DIR, exist_ok=True)
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
@require_auth
def health_check():
    """Health check — M1 DAG 健康依赖图：分级状态 + 各检查项 + 原因。

    向后兼容：保留 status='healthy'（进程存活即健康）、current_model、uptime 等旧字段；
    新增 checks（process/config/providers）与 reasons 供 manager 聚合、dashboard 展示原因。
    """
    config_path = find_config_yaml()
    config_data = parse_config_yaml(config_path) if os.path.exists(config_path) else {}
    current_model = get_current_model(config_data)

    checks = {'process': True, 'config': True, 'providers': True}
    reasons = []

    # config: 配置文件存在且可解析
    if os.path.exists(config_path):
        if not config_data:
             # 文件存在但解析为空（YAML 解析异常或空文件）
            checks['config'] = False
            reasons.append('配置文件解析为空或异常')
        elif current_model:
             # 正常读到了当前模型
            pass
        else:
            # 有 providers 但取不到 default_model —— 降级，非致命
            checks['config'] = False
            reasons.append('无法从配置读取当前模型')
    else:
        checks['config'] = False
        reasons.append('未配置文件: ' + config_path)

    # providers: providers.json 存在时校验合法性；不存在视为正常（默认态）
    try:
       if os.path.exists(PROVIDERS_FILE):
           with open(PROVIDERS_FILE, 'r') as f:
               data = json.load(f)
           if not isinstance(data, list):
               raise ValueError('providers.json 顶层不是数组')
    except Exception as e:
       checks['providers'] = False
       reasons.append('providers.json 损坏: ' + str(e))

    all_ok = checks['process'] and checks['config'] and checks['providers']
    return jsonify({
        'status': 'healthy' if all_ok else 'degraded',
        'uptime': time.time(),
        'current_model': current_model,
        'config_path': config_path,
        'checks': checks,
        'reasons': reasons,
        'timestamp': datetime.utcnow().isoformat(),
    })


@app.route('/v1/models', methods=['GET'])
@require_auth
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
@require_auth
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
@require_auth
def get_routing_mode():
    """Get current routing mode."""
    load_routing_mode()
    return jsonify({'mode': routing_mode})


@app.route('/api/set-routing-mode', methods=['POST'])
@require_auth
def set_routing_mode():
    """Set routing mode."""
    data = request.get_json()
    mode = data.get('mode') if data else None

    if mode not in ['codex', 'config', 'both']:
        return jsonify({'success': False, 'error': 'Invalid mode', 'code': 'INVALID_MODE'}), 400

    if update_routing_mode(mode):
        return jsonify({'success': True, 'mode': mode})
    else:
        # 与 codex-proxy 对齐：写文件失败统一返回 WRITE_FAILED
        return jsonify({'success': False, 'error': 'Failed to update routing mode', 'code': 'WRITE_FAILED'}), 500


@app.route('/api/providers/status', methods=['GET'])
@require_auth
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


@app.route('/api/history', methods=['GET'])
@require_auth
def get_history():
    """Get switch history."""
    return jsonify({
        'history': switch_history[:20][::-1]  # Last 20 entries, reversed
    })


@app.route('/api/switch-model', methods=['POST'])
@require_auth
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
        # 与 codex-proxy 对齐：switch-model 配置更新失败统一返回 SWITCH_FAILED
        return jsonify({'success': False, 'error': result['error'], 'code': 'SWITCH_FAILED'}), 500

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
@require_auth
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
@require_auth
def clear_history():
    """Clear switch history."""
    global switch_history
    switch_history = []
    return jsonify({'success': True})


# ===== Provider CRUD =====

# GET /api/providers
@app.route('/api/providers', methods=['GET'])
@require_auth
def get_providers():
    safe = []
    for p in providers:
        sp = dict(p)
        if sp.get('api_key'):
            # 与 codex-proxy 掩码规则一致：无条件只保留前 4 字符，
            # 短 key 也掩码（否则 len<=4 的 key 会整串泄漏给前端）。
            sp['api_key'] = sp['api_key'][:4] + '****'
        else:
            sp['api_key'] = ''
        safe.append(sp)
    return jsonify({'providers': safe})


# POST /api/providers
@app.route('/api/providers', methods=['POST'])
@require_auth
def create_provider():
    data = request.get_json() or {}
    name = data.get('name', '')
    provider_id = data.get('provider_id', '')
    api_key = data.get('api_key', '')
    base_url = data.get('base_url', '')
    enabled = data.get('enabled', True)

    if not all([name, provider_id, api_key, base_url]):
        return jsonify({'success': False, 'error': 'Missing required fields: name, provider_id, api_key, base_url'}), 400

    if any(p['provider_id'] == provider_id for p in providers):
        return jsonify({'success': False, 'error': 'Provider ID already exists'}), 409

    provider = {
        'id': generate_id(),
        'name': name,
        'provider_id': provider_id,
        'api_key': api_key,
        'base_url': base_url,
        'enabled': enabled,
        'created_at': datetime.utcnow().isoformat(),
        'updated_at': datetime.utcnow().isoformat(),
    }
    providers.append(provider)
    save_providers(providers)
    return jsonify({'success': True, 'provider': provider})


# PUT /api/providers/<id>
@app.route('/api/providers/<provider_id>', methods=['PUT'])
@require_auth
def update_provider(provider_id):
    idx = next((i for i, p in enumerate(providers) if p['id'] == provider_id), -1)
    if idx == -1:
        return jsonify({'success': False, 'error': 'Provider not found'}), 404

    data = request.get_json() or {}
    allowed_fields = ['name', 'provider_id', 'api_key', 'base_url', 'enabled']
    for field in allowed_fields:
        if field in data:
            providers[idx][field] = data[field]

    providers[idx]['updated_at'] = datetime.utcnow().isoformat()
    save_providers(providers)
    return jsonify({'success': True, 'provider': providers[idx]})


# DELETE /api/providers/<id>
@app.route('/api/providers/<provider_id>', methods=['DELETE'])
@require_auth
def delete_provider(provider_id):
    idx = next((i for i, p in enumerate(providers) if p['id'] == provider_id), -1)
    if idx == -1:
        return jsonify({'success': False, 'error': 'Provider not found'}), 404

    providers.pop(idx)
    save_providers(providers)
    return jsonify({'success': True})


# Balance detection helpers
BALANCE_ENDPOINTS = {
    'deepseek': ('https://api.deepseek.com/user/info', 'GET'),
    'moonshot': ('https://api.moonshot.cn/user/info', 'GET'),
    'agnes': ('https://apihub.agnes-ai.com/user/balance', 'GET'),
    'openai': ('https://api.openai.com/dashboard/billing/credit_grants', 'GET'),
    'anthropic': None,
    'ollama': None,
}


def detect_provider_type(provider_id):
    lower = provider_id.lower()
    for key in BALANCE_ENDPOINTS:
        if key in lower:
            return key
    return 'generic'


# Enhanced /api/balances
@app.route('/api/balances', methods=['GET'])
@require_auth
def get_balances():
    balances = {}
    for provider in providers:
        if not provider.get('enabled') or not provider.get('api_key'):
            balances[provider.get('name', 'Unknown')] = '未启用'
            continue

        ptype = detect_provider_type(provider.get('provider_id', ''))
        endpoint = BALANCE_ENDPOINTS.get(ptype)

        if endpoint is None:
            balances[provider.get('name', 'Unknown')] = '不支持'
            continue

        method, url = endpoint
        try:
            headers = {'Authorization': f'Bearer {provider["api_key"]}'}
            resp = requests.request(method, url, headers=headers, timeout=10)
            if resp.ok:
                data = resp.json()
                for key in ['balance', 'amount', 'totalAmount', 'total_available']:
                    if key in data:
                        balances[provider.get('name', 'Unknown')] = data[key]
                        break
                else:
                    balances[provider.get('name', 'Unknown')] = '未知'
            else:
                balances[provider.get('name', 'Unknown')] = f'查询失败 (HTTP {resp.status_code})'
        except Exception as e:
            balances[provider.get('name', 'Unknown')] = f'错误: {str(e)}'

    return jsonify({'balances': balances})


# Main entry point
if __name__ == '__main__':
    logger.info(f"Hermes Multi-Model Proxy starting on port {PORT}")
    logger.info(f"Config path: {find_config_yaml()}")

    # Load initial routing mode
    load_routing_mode()

    # P0-2: Docker 里必须绑 0.0.0.0 端口映射才通；本机默认 127.0.0.1
    bind_host = os.environ.get('BIND_HOST', '127.0.0.1')
    app.run(host=bind_host, port=PORT, debug=False)
