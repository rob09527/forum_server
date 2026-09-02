#!/usr/bin/env node
/**
 * AI驱动社区模拟器 - 使用已有用户池
 * 先批量创建用户池，然后循环使用这些用户发帖评论
 */

import crypto from 'crypto';

const FORUM_API_BASE = 'http://127.0.0.1:3001/api';
const CATEGORIES = ['general', 'llm', 'agent', 'prompt', 'art', 'opensource', 'tools', 'paper', 'share'];

// API配置
const API_KEY = 'sk-p3CVebSXYkJ9IuVBX5NAPz8Nif8wu7SYu3Da3tOT5sl65e9p';
const API_BASE = 'https://api.zhengmi.org/v1';
const MODEL = 'claude-opus-4-6';

const CATEGORY_GUIDES = {
  general: '综合讨论 - 技术开发、工具使用、经验分享等',
  llm: '大模型 - Claude、GPT、Deepseek等大语言模型的使用体验和讨论',
  agent: 'AI Agent - AutoGPT、LangChain、智能代理开发',
  prompt: 'Prompt工程 - 提示词技巧、few-shot学习',
  art: 'AI绘画 - Midjourney、Stable Diffusion、FLUX等',
  opensource: '开源模型 - 本地部署、模型微调',
  tools: 'AI工具 - 效率工具、开发工具推荐',
  paper: '论文解读 - 最新AI论文分享和讨论',
  share: '经验分享 - 项目经验、踩坑记录、学习心得'
};

const random = {
  int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  pick: (arr) => arr[random.int(0, arr.length - 1)],
  bool: (probability = 0.5) => Math.random() < probability
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callClaude(prompt, systemPrompt = '') {
  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 500
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (error) {
    console.error('  ⚠️ AI调用失败:', error.message);
  }
  return null;
}

async function apiRequest(endpoint, options = {}) {
  const url = `${FORUM_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response.json();
}

// 创建用户池
async function createUserPool(count) {
  console.log(`\n📦 开始创建${count}个用户池...\n`);
  const users = [];

  for (let i = 0; i < count; i++) {
    const username = `ai_user_${Date.now()}_${random.int(1000, 9999)}`;
    const email = `${username}@forum.test`;

    try {
      const result = await apiRequest('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username,
          email,
          password: 'test123456'
        })
      });

      if (result.success) {
        const user = {
          username,
          token: result.data.token,
          userId: result.data.user.id,
          points: 0
        };

        // 签到
        await sleep(500);
        const checkinResult = await apiRequest('/checkin', {
          method: 'POST',
          headers: { Cookie: `token=${user.token}` }
        });

        if (checkinResult.success) {
          user.points = checkinResult.data.newBalance;
        }

        users.push(user);
        console.log(`✓ ${i+1}/${count} ${username} (积分:${user.points})`);
      } else {
        console.log(`✗ ${i+1}/${count} 注册失败: ${result.error?.message}`);
      }
    } catch (error) {
      console.log(`✗ ${i+1}/${count} 异常: ${error.message}`);
    }

    await sleep(random.int(3000, 5000)); // 慢速创建避免限流
  }

  console.log(`\n✅ 用户池创建完成: ${users.length}个用户\n`);
  return users;
}

// AI生成帖子
async function aiCreatePost(user, category) {
  const guide = CATEGORY_GUIDES[category];
  const systemPrompt = `你是论坛用户，要在"${guide}"分类发帖。
要求：
1. 标题15-25字，不用书名号引号
2. 内容80-200字，自然真实
3. 不要AI腔，不说"作为xxx"
4. 可以提问、分享、讨论、吐槽
5. 返回JSON: {"title":"xxx","content":"xxx"}`;

  const aiResponse = await callClaude(`生成一个${guide}的帖子`, systemPrompt);
  if (!aiResponse) return null;

  try {
    const parsed = JSON.parse(aiResponse.replace(/```json\n?|\n?```/g, ''));
    if (!parsed.title || !parsed.content) return null;

    const result = await apiRequest('/posts', {
      method: 'POST',
      headers: { Cookie: `token=${user.token}` },
      body: JSON.stringify({
        title: parsed.title,
        content: parsed.content,
        category,
        tags: []
      })
    });

    if (result.success) {
      console.log(`  ✓ ${user.username} 发帖: ${parsed.title}`);
      return result.data.id;
    }
  } catch (error) {}
  return null;
}

// AI生成评论
async function aiCreateComment(user, postId, postTitle, postContent, isReply = false) {
  const systemPrompt = `你是论坛用户。
要求：
1. ${isReply ? '10-25字简短回复' : '30-100字评论'}
2. 针对内容回复，真实自然
3. 可用口语"哈哈""确实""我也遇到过"
4. 不要AI腔
5. 只返回文本，不要JSON`;

  const prompt = isReply
    ? `帖子:《${postTitle}》\n写个简短回复`
    : `帖子:《${postTitle}》\n内容: ${postContent.substring(0, 200)}\n写条评论`;

  const comment = await callClaude(prompt, systemPrompt);
  if (!comment) return null;

  try {
    const result = await apiRequest(`/posts/${postId}/comments`, {
      method: 'POST',
      headers: { Cookie: `token=${user.token}` },
      body: JSON.stringify({
        content: comment.replace(/^["']|["']$/g, ''),
        parentId: isReply || null
      })
    });

    if (result.success) {
      console.log(`  ✓ ${user.username} ${isReply ? '回复' : '评论'}: ${comment.substring(0, 20)}...`);
      return result.data.id;
    }
  } catch (error) {}
  return null;
}

// 获取帖子详情
async function getPostDetails(postId) {
  try {
    const result = await apiRequest(`/posts/${postId}`);
    return result.success ? { title: result.data.title, content: result.data.content } : null;
  } catch {
    return null;
  }
}

// 主循环
async function mainLoop(userPool) {
  const recentPosts = [];
  const postDetailsCache = new Map();
  let cycle = 0;

  while (true) {
    cycle++;
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⏱  ${new Date().toLocaleTimeString()} - 周期 #${cycle}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // 随机选2-4个用户活跃
    const activeCount = random.int(2, 4);
    const activeUsers = [];
    for (let i = 0; i < activeCount; i++) {
      activeUsers.push(random.pick(userPool));
    }

    for (const user of activeUsers) {
      const actions = random.int(1, 3); // 每个用户1-3个动作

      for (let a = 0; a < actions; a++) {
        const actionType = random.int(1, 100);

        if (actionType <= 40 && recentPosts.length < 50) {
          // 40% 发帖
          const category = random.pick(CATEGORIES);
          const postId = await aiCreatePost(user, category);
          if (postId) {
            recentPosts.push(postId);
            if (recentPosts.length > 100) recentPosts.shift();
          }
          await sleep(random.int(2000, 4000));

        } else if (actionType <= 85 && recentPosts.length > 0) {
          // 45% 评论
          const postId = random.pick(recentPosts);
          if (!postDetailsCache.has(postId)) {
            const details = await getPostDetails(postId);
            if (details) postDetailsCache.set(postId, details);
          }
          const details = postDetailsCache.get(postId);
          if (details) {
            await aiCreateComment(user, postId, details.title, details.content);
          }
          await sleep(random.int(2000, 4000));

        } else if (recentPosts.length > 0) {
          // 15% 点赞
          const postId = random.pick(recentPosts);
          try {
            await apiRequest(`/posts/${postId}/like`, {
              method: 'POST',
              headers: { Cookie: `token=${user.token}` }
            });
            console.log(`  ✓ ${user.username} 点赞`);
          } catch {}
          await sleep(1000);
        }
      }

      await sleep(random.int(1000, 2000));
    }

    console.log(`\n✓ 周期完成 | 用户池:${userPool.length} | 帖子池:${recentPosts.length}`);
    await sleep(random.int(15000, 25000)); // 15-25秒一轮
  }
}

// 启动
(async () => {
  console.log('🤖 AI驱动社区模拟器 v2');
  console.log(`🔑 API: ${API_KEY.substring(0, 15)}...`);
  console.log(`🌐 模型: ${MODEL}\n`);

  const userPool = await createUserPool(10); // 先创建10个用户

  if (userPool.length < 3) {
    console.error('❌ 用户池太少，无法继续');
    process.exit(1);
  }

  console.log('🎭 开始持续模拟...\n');
  await mainLoop(userPool);
})().catch(console.error);
