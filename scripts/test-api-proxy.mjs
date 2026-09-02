// 测试通过代理访问API
import { SocksProxyAgent } from 'socks-proxy-agent';

const API_KEY = 'sk-p3CVebSXYkJ9IuVBX5NAPz8Nif8wu7SYu3Da3tOT5sl65e9p';
const API_BASE = 'https://api.zhengmi.org/v1';

const proxyAgent = new SocksProxyAgent('socks5://GL5XBQJhyyitanY:XQ6UyohioAB4e87@48.44.57.139:47002');

async function test() {
  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      agent: proxyAgent,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: '说一句话' }],
        max_tokens: 50
      })
    });

    console.log('状态:', response.status);
    const data = await response.json();
    console.log('响应:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('错误:', error.message);
  }
}

test();
