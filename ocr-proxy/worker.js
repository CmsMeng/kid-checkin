/**
 * kid-checkin-ocr — Cloudflare Worker
 * 代理百度 OCR API，解决浏览器 CORS 限制
 *
 * 部署前设置 Secret：
 *   npx wrangler secret put BAIDU_API_KEY
 *   npx wrangler secret put BAIDU_SECRET_KEY
 */

// 缓存 access_token（30 天有效，过期前 1 小时刷新）
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken(env) {
  const now = Date.now();
  if (_cachedToken && _tokenExpiresAt > now + 3600_000) {
    return _cachedToken;
  }

  const apiKey = env.BAIDU_API_KEY;
  const secretKey = env.BAIDU_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error('未配置 BAIDU_API_KEY / BAIDU_SECRET_KEY，请用 wrangler secret put 设置');
  }

  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${apiKey}&client_secret=${secretKey}`;

  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json();

  if (data.error) {
    throw new Error(`百度 OAuth 失败: ${data.error_description || data.error}`);
  }

  _cachedToken = data.access_token;
  _tokenExpiresAt = now + (data.expires_in || 2592000) * 1000;
  return _cachedToken;
}

async function callBaiduOCR(accessToken, imageBase64) {
  const body = new URLSearchParams();
  body.append('image', imageBase64);
  // 通用文字识别（标准版），免费 500 次/天
  // 可选提升精度参数
  body.append('detect_direction', 'true');       // 自动检测图片方向
  body.append('paragraph', 'true');              // 段落识别模式
  body.append('probability', 'false');           // 不返回单字置信度（减小响应）

  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=${accessToken}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  return resp.json();
}

export default {
  async fetch(request, env) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 仅接受 POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error_code: 405, error_msg: 'Method Not Allowed' }), {
        status: 405,
        headers: corsHeaders(),
      });
    }

    try {
      const { image } = await request.json();

      if (!image || typeof image !== 'string' || image.length < 100) {
        return new Response(JSON.stringify({
          error_code: 400,
          error_msg: '请提供有效的 base64 图片数据',
        }), { status: 400, headers: corsHeaders() });
      }

      const accessToken = await getAccessToken(env);
      const result = await callBaiduOCR(accessToken, image);

      return new Response(JSON.stringify(result), {
        headers: corsHeaders(),
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error_code: 500,
        error_msg: err.message || 'Worker 内部错误',
      }), { status: 500, headers: corsHeaders() });
    }
  },
};

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
}
