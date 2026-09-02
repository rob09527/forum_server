#!/usr/bin/env node
/**
 * AI社区模拟器 - 使用现有测试账号
 */

const FORUM_API = 'http://127.0.0.1:3001/api';
const API_KEY = 'sk-p3CVebSXYkJ9IuVBX5NAPz8Nif8wu7SYu3Da3tOT5sl65e9p';
const API_BASE = 'https://api.zhengmi.org/v1';
const MODEL = 'claude-opus-4-6';

const CATEGORIES = ['general', 'llm', 'agent', 'prompt', 'art', 'opensource', 'tools', 'paper', 'share'];

// 使用已有的demo账号
const TEST_USERS = [
  { email: 'demo_user_ui@forum.local', password: 'demo123456' }
];

const random = {
  int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  pick: (arr) => arr[random.int(0, arr.length - 1)]
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiCall(endpoint, options = {}) {
  const response = await fetch(`${FORUM_API}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  return response.json();
}

async function aiCall(prompt, system = '') {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt }
      ],
      temperature: 0.9,
      max_tokens: 400
    })
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim();
}

async function login(email, password) {
  const result = await apiCall('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  return result.success ? result.data.token : null;
}

async function aiPost(token, category) {
  const guides = {
    general: '综合技术讨论',
    llm: 'Claude、GPT等大模型',
    agent: 'AI Agent开发',
    prompt: 'Prompt技巧',
    art: 'AI绘画'
  };
  
  const system = `你是技术论坛用户，在"${guides[category] || '技术'}"板块发帖。
要求：标题15字内，内容80-150字，真实自然，不要AI腔。
返回JSON: {"title":"标题","content":"内容"}`;

  const ai = await aiCall('生成一个帖子', system);
  if (!ai) return null;

  try {
    const post = JSON.parse(ai.replace(/```json\n?|\n?```/g, ''));
    const result = await apiCall('/posts', {
      method: 'POST',
      headers: { Cookie: `token=${token}` },
      body: JSON.stringify({ ...post, category, tags: [] })
    });
    if (result.success) {
      console.log(`✓ 发帖: ${post.title}`);
      return result.data.id;
    }
  } catch {}
  return null;
}

async function aiComment(token, postId, title, content) {
  const system = `你是论坛用户，要评论《${title}》这个帖子。
要求：30-80字，真实自然，可用口语，不要AI腔。只返回文本。`;

  const comment = await aiCall(`帖子内容: ${content.substring(0, 150)}`, system);
  if (!comment) return null;

  const result = await apiCall(`/posts/${postId}/comments`, {
    method: 'POST',
    headers: { Cookie: `token=${token}` },
    body: JSON.stringify({ content: comment.replace(/^["']|["']$/g, ''), parentId: null })
  });

  if (result.success) {
    console.log(`✓ 评论: ${comment.substring(0, 25)}...`);
    return true;
  }
  return false;
}

async function getPost(id) {
  const r = await apiCall(`/posts/${id}`);
  return r.success ? { title: r.data.title, content: r.data.content } : null;
}

// 主循环
(async () => {
  console.log('🤖 AI社区模拟器');
  console.log('🔑 使用demo账号 + Claude Opus 4.6\n');

  const token = await login(TEST_USERS[0].email, TEST_USERS[0].password);
  if (!token) {
    console.error('❌ 登录失败');
    process.exit(1);
  }

  console.log('✓ 登录成功\n');

  const posts = [];
  let cycle = 0;

  while (true) {
    cycle++;
    console.log(`\n━━━ 周期 #${cycle} - ${new Date().toLocaleTimeString()} ━━━\n`);

    // 发1-2个帖子
    const postCount = random.int(1, 2);
    for (let i = 0; i < postCount; i++) {
      const cat = random.pick(CATEGORIES);
      const postId = await aiPost(token, cat);
      if (postId) posts.push(postId);
      if (posts.length > 50) posts.shift();
      await sleep(random.int(3000, 5000));
    }

    // 评论1-3个已有帖子
    if (posts.length > 0) {
      const commentCount = random.int(1, 3);
      for (let i = 0; i < commentCount; i++) {
        const postId = random.pick(posts);
        const post = await getPost(postId);
        if (post) {
          await aiComment(token, postId, post.title, post.content);
        }
        await sleep(random.int(2000, 4000));
      }
    }

    console.log(`\n✓ 周期完成，帖子池: ${posts.length}`);
    await sleep(random.int(20000, 30000)); // 20-30秒一轮
  }
})();
