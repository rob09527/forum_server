#!/usr/bin/env node
/**
 * 用户行为模拟脚本
 * 模拟真实社区活跃度,创建用户、发帖、评论、购买商品等行为
 */

import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:3001/api';
const CATEGORIES = ['general', 'llm', 'agent', 'prompt', 'art', 'opensource', 'tools', 'paper', 'share'];

// 真实的用户名素材库
const USERNAME_PARTS = {
  prefix: ['小', '老', '阿', '大', '云', '星', '月', '风', '雨', '雪', '林', '江', '海', '山', '天'],
  middle: ['coding', 'tech', 'dev', 'AI', 'geek', 'code', 'data', 'hack', 'bug', 'pro'],
  suffix: ['哥', '姐', '酱', '君', '桑', '师', 'er', '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周']
};

// 真实的帖子主题库(按分类)
const POST_TOPICS = {
  general: [
    { title: '今天部署遇到个奇怪的问题', content: '用docker部署,端口明明映射了,但是访问不了,最后发现是防火墙的问题...' },
    { title: '有人用过Cursor吗?感觉怎么样', content: '最近看到很多人推荐Cursor这个AI编辑器,有实际用过的吗?和Copilot比怎么样?' },
    { title: '分享一个提高工作效率的小技巧', content: '最近发现用tmux+vim能大幅提升效率,特别是多窗口切换的时候' },
    { title: '周末加班改bug到现在', content: '线上出了个并发问题,排查了一整天,终于定位到是Redis锁的问题' },
    { title: '有推荐的技术博客吗', content: '想学习一下系统设计方面的知识,大家有什么推荐的博客或者书籍吗' }
  ],
  llm: [
    { title: 'Claude和GPT到底哪个好用?', content: '用了一段时间,感觉Claude写代码更稳,GPT创意更好,大家怎么看?' },
    { title: 'Deepseek v3性价比真高', content: '最近在用Deepseek v3,性价比确实不错,基本能满足日常需求了' },
    { title: '本地部署Llama遇到的坑', content: '想本地跑个Llama模型,结果显存不够,有什么优化方案吗?' },
    { title: 'prompt工程师会是未来的趋势吗', content: '感觉现在写prompt也是个技术活,这个职业会长期存在吗?' },
    { title: 'AI写的代码质量怎么样', content: '让AI生成了一段代码,能跑但总觉得有点怪,大家生产环境敢直接用吗?' }
  ],
  agent: [
    { title: 'AutoGPT实战分享', content: '试了下AutoGPT做数据分析,效果还行但容易跑偏,需要多调试' },
    { title: 'Agent的记忆管理怎么做', content: '做了个Agent但是上下文很快就爆了,大家是怎么处理长期记忆的?' },
    { title: 'LangChain还是LlamaIndex', content: '准备做个RAG应用,这两个框架选哪个比较好?' },
    { title: '多Agent协作的实现思路', content: '想让多个Agent协同工作,有什么好的架构设计吗?' }
  ],
  prompt: [
    { title: '分享几个实用的prompt模板', content: '整理了几个常用的prompt,涵盖代码审查、文档生成等场景' },
    { title: 'CoT真的有用吗', content: '加了Chain of Thought后效果好像也没明显提升,是我用法不对吗?' },
    { title: 'Few-shot学习的最佳实践', content: '给几个例子效果确实好很多,但token消耗也大了,怎么平衡?' }
  ],
  art: [
    { title: 'Midjourney v7出来了', content: '新版本的图片质量真的好很多,特别是人物细节' },
    { title: 'SD3还是FLUX', content: '最近在选开源绘画模型,这两个哪个更适合商用?' },
    { title: 'AI绘画的版权问题', content: 'AI生成的图片版权归谁?用于商业项目会有风险吗?' }
  ],
  share: [
    { title: '从0到1搭建技术博客的经验', content: '用Nuxt+Markdown搭了个博客,分享下踩过的坑' },
    { title: '我的开源项目终于有100 star了', content: '坚持维护了半年,今天终于破百了,有点小激动' },
    { title: '面试官问的奇葩问题', content: '今天面试被问"如果你是一个数据结构,你会是什么",怎么回答?' }
  ]
};

// 真实的评论库
const COMMENT_TEMPLATES = [
  '有道理,我之前也遇到过类似的问题',
  '学到了,感谢分享',
  '这个思路不错,可以试试',
  '我觉得还可以这样优化...',
  '楼主说得对',
  '有没有demo可以参考?',
  '具体怎么实现的?能详细说说吗',
  '这个方案有什么坑吗?',
  '实际用下来效果怎么样?',
  '收藏了,回头试试',
  '确实,我也是这么做的',
  '有源码吗?想学习下',
  '这个角度挺新颖的',
  '不太同意,我觉得...',
  '有道理但是...',
  '补充一点...',
  '我遇到的情况不太一样',
  '可以分享下配置吗?',
  '这个性能怎么样?',
  '生产环境稳定吗?',
  'mark一下',
  '正好需要,感谢',
  '可以可以',
  '牛的',
  '强',
  '6666',
  '哈哈哈我也是',
  '同感',
  '有点意思',
  '涨知识了'
];

// 楼中楼评论库
const REPLY_TEMPLATES = [
  '说得对',
  '同意',
  '确实如此',
  '我也这么觉得',
  '有道理',
  '赞同',
  '可以的',
  '对对对',
  '就是这样',
  '+1',
  '我也是',
  '哈哈对',
  '没错',
  '支持',
  '有点道理',
  '可以试试',
  '谢谢',
  '好的',
  '了解了',
  '学到了'
];

// 随机工具函数
const random = {
  int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  pick: (arr) => arr[random.int(0, arr.length - 1)],
  bool: (probability = 0.5) => Math.random() < probability,
  shuffle: (arr) => arr.sort(() => Math.random() - 0.5)
};

// 生成随机用户名
function generateUsername() {
  const patterns = [
    () => random.pick(USERNAME_PARTS.prefix) + random.pick(USERNAME_PARTS.middle) + random.int(100, 999),
    () => random.pick(USERNAME_PARTS.middle) + '_' + random.pick(USERNAME_PARTS.suffix),
    () => random.pick(USERNAME_PARTS.prefix) + random.pick(USERNAME_PARTS.suffix) + random.int(10, 99),
    () => random.pick(USERNAME_PARTS.middle).toLowerCase() + random.int(2020, 2026)
  ];
  return random.pick(patterns)();
}

// 生成随机邮箱
function generateEmail(username) {
  const domains = ['gmail.com', 'qq.com', '163.com', 'outlook.com', 'hotmail.com'];
  return `${username.toLowerCase()}@${random.pick(domains)}`;
}

// API请求封装
async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response.json();
}

// 用户类
class SimulatedUser {
  constructor() {
    this.username = generateUsername();
    this.email = generateEmail(this.username);
    this.password = 'test123456';
    this.token = null;
    this.userId = null;
    this.points = 0;
    this.recentCommentIds = []; // 记录自己发的评论ID,用于楼中楼
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
        console.log(`✓ 用户注册成功: ${this.username}`);
        return true;
      }
    } catch (error) {
      console.log(`✗ 注册失败 ${this.username}: ${error.message}`);
    }
    return false;
  }

  async checkin() {
    try {
      const result = await apiRequest('/checkin', {
        method: 'POST',
        headers: {
          Cookie: `token=${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({}) // 空对象而不是undefined
      });

      if (result.success) {
        // 签到返回的delta就是获得的积分
        this.points += result.data.delta;
        console.log(`  ✓ ${this.username} 签到成功,+${result.data.delta},余额: ${this.points}`);
        return true;
      } else {
        console.log(`  ✗ 签到失败 ${this.username}: ${result.error?.message}`);
      }
    } catch (error) {
      console.log(`  ✗ 签到异常 ${this.username}: ${error.message}`);
    }
    return false;
  }

  async createPost(category) {
    const topics = POST_TOPICS[category] || POST_TOPICS.general;
    const topic = random.pick(topics);

    try {
      const result = await apiRequest('/posts', {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` },
        body: JSON.stringify({
          title: topic.title,
          content: topic.content,
          category: category,
          tags: []
        })
      });

      if (result.success) {
        console.log(`  ✓ ${this.username} 发布帖子: ${topic.title.substring(0, 20)}...`);
        return result.data.id;
      }
    } catch (error) {
      console.log(`  ✗ 发帖失败 ${this.username}`);
    }
    return null;
  }

  async commentOnPost(postId, parentId = null) {
    const content = parentId ? random.pick(REPLY_TEMPLATES) : random.pick(COMMENT_TEMPLATES);

    try {
      const result = await apiRequest(`/posts/${postId}/comments`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` },
        body: JSON.stringify({ content, parentId })
      });

      if (result.success) {
        const type = parentId ? '回复' : '评论';
        console.log(`  ✓ ${this.username} ${type}: ${content.substring(0, 15)}...`);
        if (!parentId) {
          this.recentCommentIds.push(result.data.id);
          if (this.recentCommentIds.length > 10) this.recentCommentIds.shift();
        }
        return result.data.id;
      }
    } catch (error) {
      console.log(`  ✗ 评论失败 ${this.username}`);
    }
    return null;
  }

  async likePost(postId) {
    try {
      const result = await apiRequest(`/posts/${postId}/like`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });

      if (result.success) {
        console.log(`  ✓ ${this.username} 点赞了帖子`);
        return true;
      }
    } catch (error) {}
    return false;
  }

  async purchaseShopItem() {
    try {
      // 获取商品列表
      const shopResult = await apiRequest('/shop/items');
      if (!shopResult.success || !shopResult.data.items.length) {
        return false;
      }

      // 按类型分组
      const itemsByType = {
        title: [],
        username_color: [],
        avatar_frame: [],
        avatar: []
      };

      shopResult.data.items.forEach(item => {
        if (item.price > 0 && item.price <= this.points && item.price < 10000) {
          const type = item.type;
          if (itemsByType[type]) {
            itemsByType[type].push(item);
          }
        }
      });

      const typeNames = {
        'title': '称号',
        'username_color': '用户名颜色',
        'avatar_frame': '头像框',
        'avatar': '头像'
      };

      // 每个类型随机购买一个
      for (const [type, items] of Object.entries(itemsByType)) {
        if (items.length === 0) continue;

        const item = random.pick(items);

        const result = await apiRequest(`/shop/items/${item.id}/purchase`, {
          method: 'POST',
          headers: {
            Cookie: `token=${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });

        if (result.success) {
          this.points -= item.price;
          const typeName = typeNames[type] || type;
          console.log(`  ✓ ${this.username} 购买了${typeName}: ${item.name} (花费${item.price}积分,余额${this.points})`);

          // 购买后立即激活
          await this.sleep(500);
          await this.activateDecoration(result.data.id);
        }

        await this.sleep(random.int(300, 600)); // 购买间隔
      }

      return true;
    } catch (error) {
      console.log(`  ✗ ${this.username} 购买异常: ${error.message}`);
    }
    return false;
  }

  async activateDecoration(decorationId) {
    try {
      const result = await apiRequest(`/shop/mine/${decorationId}/activate`, {
        method: 'POST',
        headers: { Cookie: `token=${this.token}` }
      });

      if (result.success) {
        console.log(`  ✓ ${this.username} 激活了装饰`);
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
class CommunitySimulator {
  constructor() {
    this.users = [];
    this.recentPosts = [];
    this.recentComments = []; // 记录最近的评论,用于楼中楼
    this.isRunning = false;
  }

  async init() {
    console.log('🚀 社区模拟器启动中...\n');
  }

  async createAndInitUser() {
    const user = new SimulatedUser();
    if (await user.register()) {
      await this.sleep(500);
      await user.checkin();
      this.users.push(user);
      return user;
    }
    return null;
  }

  async simulateUserBehavior() {
    const user = await this.createAndInitUser();
    if (!user) return;

    await this.sleep(random.int(300, 1000));

    // 随机行为列表
    const actions = [];

    // 80% 概率发帖
    if (random.bool(0.8)) {
      const category = random.pick(CATEGORIES);
      actions.push(async () => {
        const postId = await user.createPost(category);
        if (postId) this.recentPosts.push(postId);
        if (this.recentPosts.length > 150) this.recentPosts.shift();
      });
    }

    // 100% 概率评论已有帖子
    if (this.recentPosts.length > 0) {
      actions.push(async () => {
        const postId = random.pick(this.recentPosts);
        const commentId = await user.commentOnPost(postId);
        if (commentId) {
          this.recentComments.push({ postId, commentId, userId: user.userId });
          if (this.recentComments.length > 100) this.recentComments.shift();
        }
      });
    }

    // 40% 概率楼中楼回复
    if (random.bool(0.4) && this.recentComments.length > 0) {
      actions.push(async () => {
        const comment = random.pick(this.recentComments);
        // 不回复自己的评论
        if (comment.userId !== user.userId) {
          await user.commentOnPost(comment.postId, comment.commentId);
        }
      });
    }

    // 60% 概率点赞
    if (random.bool(0.6) && this.recentPosts.length > 0) {
      actions.push(async () => {
        const postId = random.pick(this.recentPosts);
        await user.likePost(postId);
      });
    }

    // 100% 概率购买商品(如果积分足够)
    if (user.points > 500) {
      actions.push(async () => {
        await user.purchaseShopItem();
      });
    }

    // 执行随机行为
    for (const action of random.shuffle(actions)) {
      await action();
      await this.sleep(random.int(260, 780)); // 增加30%延迟: 原200-600 -> 260-780
    }
  }

  async getExistingPosts() {
    try {
      const result = await apiRequest('/posts?page=1&limit=20');
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
    const userCount = random.int(10, 14); // 提升1倍: 原5-7 -> 10-14
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`⏱  新周期: ${new Date().toLocaleTimeString()} - 模拟 ${userCount} 个用户行为`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const promises = [];
    for (let i = 0; i < userCount; i++) {
      promises.push(this.simulateUserBehavior());
      await this.sleep(random.int(650, 1650)); // 减少延迟，提升速度
    }

    await Promise.all(promises);
    console.log(`\n✓ 周期完成,总用户: ${this.users.length}, 帖子池: ${this.recentPosts.length}, 评论池: ${this.recentComments.length}`);
  }

  async start() {
    this.isRunning = true;
    await this.init();
    await this.getExistingPosts();

    console.log('🎭 开始模拟社区活动...');
    console.log('💡 按 Ctrl+C 停止\n');

    while (this.isRunning) {
      try {
        await this.runCycle();
        await this.sleep(5000); // 缩短到5秒一个周期(原来10秒)
      } catch (error) {
        console.error('❌ 周期执行出错:', error.message);
        await this.sleep(3000);
      }
    }
  }

  stop() {
    this.isRunning = false;
    console.log('\n\n👋 模拟器已停止');
    console.log(`📊 总计创建用户: ${this.users.length}`);
    console.log(`📝 总计帖子池: ${this.recentPosts.length}`);
  }
}

// 启动
const simulator = new CommunitySimulator();

process.on('SIGINT', () => {
  simulator.stop();
  process.exit(0);
});

simulator.start().catch(console.error);
