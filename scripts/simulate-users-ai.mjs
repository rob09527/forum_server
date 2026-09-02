#!/usr/bin/env node
/**
 * AI驱动的用户行为模拟脚本
 * 使用DeepSeek API生成真实的帖子和回复内容
 */

import crypto from 'crypto';

const FORUM_API_BASE = 'http://127.0.0.1:3001/api';
const CATEGORIES = ['general', 'llm', 'agent', 'prompt', 'art', 'opensource', 'tools', 'paper', 'share'];

// API配置（三方中转，使用opus4.6）
const API_KEY = process.env.API_KEY || 'sk-p3CVebSXYkJ9IuVBX5NAPz8Nif8wu7SYu3Da3tOT5sl65e9p';
const API_BASE = 'https://api.zhengmi.org/v1';
const MODEL = 'claude-opus-4-6'; // 正确的模型名

// 用户名素材库
const USERNAME_PARTS = {
  prefix: ['小', '老', '阿', '大', '云', '星', '月', '风', '雨', '雪', '林', '江', '海', '山', '天'],
  middle: ['coding', 'tech', 'dev', 'AI', 'geek', 'code', 'data', 'hack', 'bug', 'pro'],
  suffix: ['哥', '姐', '酱', '君', '桑', '师', 'er', '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周']
};

// 分类主题指引
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

// 随机工具
const random = {
  int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  pick: (arr) => arr[random.int(0, arr.length - 1)],
  bool: (probability = 0.5) => Math.random() < probability,
  shuffle: (arr) => arr.sort(() => Math.random() - 0.5)
};

// 生成用户名
function generateUsername() {
  const patterns = [
    () => random.pick(USERNAME_PARTS.prefix) + random.pick(USERNAME_PARTS.middle) + random.int(100, 999),
    () => random.pick(USERNAME_PARTS.middle) + '_' + random.pick(USERNAME_PARTS.suffix),
    () => random.pick(USERNAME_PARTS.prefix) + random.pick(USERNAME_PARTS.suffix) + random.int(10, 99),
    () => random.pick(USERNAME_PARTS.middle).toLowerCase() + random.int(2020, 2026)
  ];
  return random.pick(patterns)();
}

function generateEmail(username) {
  const domains = ['gmail.com', 'qq.com', '163.com', 'outlook.com', 'hotmail.com'];
  return `${username.toLowerCase()}@${random.pick(domains)}`;
}

// Claude API调用（通过三方中转）
async function callClaude(prompt, systemPrompt = '') {
  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error('  ⚠️ API响应错误:', response.status, errorText.substring(0, 100));
      return null;
    }

    const data = await response.json();
    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content.trim();
    }
  } catch (error) {
    console.error('  ⚠️ API调用异常:', error.message);
  }
  return null;
}

// API请求封装
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

// AI驱动的用户类
class AISimulatedUser {
  constructor() {
    this.username = generateUsername();
    this.email = generateEmail(this.username);
    this.password = 'test123456';
    this.token = null;
    this.userId = null;
    this.points = 0;
    this.personality = this.generatePersonality(); // 生成用户性格
  }

  generatePersonality() {
    const personalities = [
      { type: '技术专家', traits: '经验丰富,喜欢深入分析,回复专业详细' },
      { type: '新手小白', traits: '刚入门,经常提问,回复简短好奇' },
      { type: '实用主义', traits: '关注实战,喜欢分享经验和踩坑记录' },
      { type: '学术派', traits: '理论扎实,喜欢引用论文和最佳实践' },
      { type: '工具控', traits: '热衷尝试新工具,喜欢对比评测' },
      { type: '段子手', traits: '幽默风趣,喜欢用轻松的语气讨论技术' },
      { type: '谨慎派', traits: '严谨细致,会指出潜在问题和风险' },
      { type: '乐观派', traits: '积极正面,喜欢鼓励和赞同别人' }
    ];
    return random.pick(personalities);
  }

  async register() {
    try {
      const result = await apiRequest('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: this.username,
          email: this.email,
          password: this.password
        })
      });

      if (result.success) {
        this.token = result.data.token;
        this.userId = result.data.user.id;
        console.log(`✓ 用户注册: ${this.username} (${this.personality.type})`);
        return true;
      } else {
        console.log(`✗ 注册失败 ${this.username}: ${result.error?.message || '未知错误'}`);
      }
    } catch (error) {
      console.log(`✗ 注册异常 ${this.username}: ${error.message}`);
    }
    return false;
  }

  async checkin() {
    try {
      const result = await apiRequest('/checkin', {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });

      if (result.success) {
        this.points = result.data.newBalance;
        console.log(`  ✓ ${this.username} 签到,余额: ${this.points}`);
        return true;
      }
    } catch (error) {}
    return false;
  }

  async createAIPost(category) {
    const categoryGuide = CATEGORY_GUIDES[category] || CATEGORY_GUIDES.general;

    const systemPrompt = `你是一个论坛用户,性格特点: ${this.personality.traits}。
你要在"${categoryGuide}"分类下发布一个帖子。
要求:
1. 标题20字以内,不要用书名号引号
2. 内容80-150字,像真人聊天一样自然
3. 不要有AI腔调,不要说"作为xxx"
4. 可以提问、分享经验、求助、讨论
5. 返回JSON格式: {"title":"xxx","content":"xxx"}`;

    const prompt = `请生成一个关于${categoryGuide}的论坛帖子`;

    const aiResponse = await callClaude(prompt, systemPrompt);
    if (!aiResponse) return null;

    try {
      // 尝试解析JSON
      const parsed = JSON.parse(aiResponse);
      if (parsed.title && parsed.content) {
        const result = await apiRequest('/posts', {
          method: 'POST',
          headers: { Cookie: `token=${this.token}` },
          body: JSON.stringify({
            title: parsed.title,
            content: parsed.content,
            category: category,
            tags: []
          })
        });

        if (result.success) {
          console.log(`  ✓ ${this.username} 发帖: ${parsed.title.substring(0, 25)}...`);
          return result.data.id;
        }
      }
    } catch (error) {
      console.log(`  ✗ 发帖解析失败 ${this.username}`);
    }
    return null;
  }

  async createAIComment(postId, postTitle, postContent, isReply = false) {
    const systemPrompt = `你是论坛用户,性格: ${this.personality.traits}。
要求:
1. ${isReply ? '15-30字的简短回复' : '30-80字的评论'}
2. 针对帖子内容回复,不要复述标题
3. 像真人聊天,可以用"哈哈""确实""我也是"等口语
4. 不要AI腔,不要说"作为xxx"
5. 只返回评论文本,不要JSON格式`;

    const prompt = isReply
      ? `帖子标题: ${postTitle}\n请给出一个简短的回复`
      : `帖子标题: ${postTitle}\n内容: ${postContent}\n请根据帖子内容写一条评论`;

    const comment = await callClaude(prompt, systemPrompt);
    if (!comment) return null;

    try {
      const result = await apiRequest(`/posts/${postId}/comments`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` },
        body: JSON.stringify({
          content: comment.replace(/^["']|["']$/g, ''), // 去除引号
          parentId: isReply ? isReply : null
        })
      });

      if (result.success) {
        const type = isReply ? '回复' : '评论';
        console.log(`  ✓ ${this.username} ${type}: ${comment.substring(0, 20)}...`);
        return result.data.id;
      }
    } catch (error) {}
    return null;
  }

  async likePost(postId) {
    try {
      const result = await apiRequest(`/posts/${postId}/like`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });
      if (result.success) {
        console.log(`  ✓ ${this.username} 点赞`);
        return true;
      }
    } catch (error) {}
    return false;
  }

  async purchaseShopItem() {
    try {
      const shopResult = await apiRequest('/shop/items');
      if (!shopResult.success) return false;

      const affordableItems = shopResult.data.items.filter(item =>
        item.price > 0 && item.price <= this.points && item.price < 10000
      );

      if (affordableItems.length === 0) return false;

      const priorityTypes = ['title', 'username_color', 'avatar_frame'];
      let item = affordableItems.find(i => priorityTypes.includes(i.type));
      if (!item) item = random.pick(affordableItems);

      const result = await apiRequest(`/shop/items/${item.id}/purchase`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });

      if (result.success) {
        this.points -= item.price;
        const typeNames = {
          'title': '称号',
          'username_color': '用户名颜色',
          'avatar_frame': '头像框',
          'avatar': '头像'
        };
        const typeName = typeNames[item.type] || item.type;
        console.log(`  ✓ ${this.username} 购买${typeName}: ${item.name} (-${item.price}, 余${this.points})`);

        await this.sleep(300);
        await this.activateDecoration(result.data.id);
        return true;
      }
    } catch (error) {}
    return false;
  }

  async activateDecoration(decorationId) {
    try {
      const result = await apiRequest(`/shop/mine/${decorationId}/activate`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });
      if (result.success) {
        console.log(`  ✓ ${this.username} 激活装饰`);
        return true;
      }
    } catch (error) {}
    return false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 主控制器
class AICommunitySimulator {
  constructor() {
    this.users = [];
    this.recentPosts = [];
    this.postDetails = new Map(); // 存储帖子详情用于生成评论
    this.recentComments = [];
    this.isRunning = false;
  }

  async init() {
    console.log('🤖 AI驱动社区模拟器启动中...');
    console.log(`🔑 API: ${API_KEY.substring(0, 15)}...`);
    console.log(`🌐 使用模型: ${MODEL}`);
    console.log('');
  }

  async createAndInitUser() {
    const user = new AISimulatedUser();
    if (await user.register()) {
      await this.sleep(500);
      await user.checkin();
      this.users.push(user);
      return user;
    }
    return null;
  }

  async getPostDetails(postId) {
    if (this.postDetails.has(postId)) {
      return this.postDetails.get(postId);
    }

    try {
      const result = await apiRequest(`/posts/${postId}`);
      if (result.success) {
        const details = {
          title: result.data.title,
          content: result.data.content
        };
        this.postDetails.set(postId, details);
        return details;
      }
    } catch (error) {}
    return null;
  }

  async simulateUserBehavior() {
    const user = await this.createAndInitUser();
    if (!user) return;

    await this.sleep(random.int(500, 1500));

    const actions = [];

    // 70% 发帖(AI生成)
    if (random.bool(0.7)) {
      actions.push(async () => {
        const category = random.pick(CATEGORIES);
        const postId = await user.createAIPost(category);
        if (postId) {
          this.recentPosts.push(postId);
          if (this.recentPosts.length > 100) this.recentPosts.shift();
        }
      });
    }

    // 80% 评论(AI生成)
    if (random.bool(0.8) && this.recentPosts.length > 0) {
      actions.push(async () => {
        const postId = random.pick(this.recentPosts);
        const postDetails = await this.getPostDetails(postId);
        if (postDetails) {
          const commentId = await user.createAIComment(
            postId,
            postDetails.title,
            postDetails.content
          );
          if (commentId) {
            this.recentComments.push({ postId, commentId, userId: user.userId, postDetails });
            if (this.recentComments.length > 80) this.recentComments.shift();
          }
        }
      });
    }

    // 40% 楼中楼
    if (random.bool(0.4) && this.recentComments.length > 0) {
      actions.push(async () => {
        const comment = random.pick(this.recentComments);
        if (comment.userId !== user.userId && comment.postDetails) {
          await user.createAIComment(
            comment.postId,
            comment.postDetails.title,
            comment.postDetails.content,
            comment.commentId
          );
        }
      });
    }

    // 50% 点赞
    if (random.bool(0.5) && this.recentPosts.length > 0) {
      actions.push(async () => {
        const postId = random.pick(this.recentPosts);
        await user.likePost(postId);
      });
    }

    // 40% 购买
    if (random.bool(0.4) && user.points > 500) {
      actions.push(async () => {
        await user.purchaseShopItem();
      });
    }

    for (const action of random.shuffle(actions)) {
      await action();
      await this.sleep(random.int(800, 1500)); // AI生成需要时间,间隔长一些
    }
  }

  async getExistingPosts() {
    try {
      const result = await apiRequest('/posts?page=1&limit=30');
      if (result.success && result.data.items) {
        this.recentPosts = result.data.items.map(p => p.id);
        console.log(`📚 加载了 ${this.recentPosts.length} 个已有帖子\n`);
      }
    } catch (error) {}
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async runCycle() {
    const userCount = random.int(3, 6); // 降低用户数避免频率限制
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⏱  ${new Date().toLocaleTimeString()} - AI生成 ${userCount} 个用户行为`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // 串行执行避免频率限制
    for (let i = 0; i < userCount; i++) {
      await this.simulateUserBehavior();
      await this.sleep(random.int(2000, 3000)); // 增加用户间延迟
    }

    console.log(`\n✓ 周期完成 | 用户: ${this.users.length} | 帖子: ${this.recentPosts.length} | 评论: ${this.recentComments.length}`);
  }

  async start() {
    this.isRunning = true;
    await this.init();
    await this.getExistingPosts();

    console.log('🎭 开始AI驱动的社区模拟...');
    console.log('💡 每个帖子和回复都经过Claude Opus 4.6思考生成');
    console.log('💡 按 Ctrl+C 停止\n');

    while (this.isRunning) {
      try {
        await this.runCycle();
        await this.sleep(20000); // 20秒一轮，避免频率限制
      } catch (error) {
        console.error('❌ 周期执行出错:', error.message);
        await this.sleep(10000);
      }
    }
  }

  stop() {
    this.isRunning = false;
    console.log('\n\n👋 AI模拟器已停止');
    console.log(`📊 总计: ${this.users.length} 用户, ${this.recentPosts.length} 帖子`);
  }
}

// 启动
const simulator = new AICommunitySimulator();

process.on('SIGINT', () => {
  simulator.stop();
  process.exit(0);
});

simulator.start().catch(console.error);
