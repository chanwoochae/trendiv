import { ScraperConfig } from '../scrapers/interface';

const MARKUP_KEYWORDS = [
  'CSS',
  'SASS',
  'HTML',
  'Web',
  'Front',
  'FE',
  '프론트엔드',
  '웹',
  '브라우저',
  'browser',
  'React',
  'Vue',
  'Next.JS',
  'NextJS',
  'Svelte',
  'Tailwind',
  'JavaScript',
  'TypeScript',
  'Accessibility',
  'A11y',
  '접근성',
  'UI/',
  'UX',
  'Design',
  'Mobile',
  'iOS',
  '스크린리더',
  'Chrome',
  'Safari',
  '크로스 브라우징',
  '렌더링',
  'rendering',
  'Lighthouse',
];

export const TARGETS: ScraperConfig[] = [
  // =================================================
  // 1. Social & Community (Platform Name = Category)
  // =================================================
  {
    name: 'X (Twitter)',
    category: 'X',
    type: 'google_search',
    url: 'site:x.com (css OR html OR "web accessibility" OR a11y) -"marketing" -"hiring" -"job" -"crypto" -"nft" -"giveaway" -"promo" -"discount"',
  },
  {
    name: 'Hacker News',
    category: 'Hacker News',
    type: 'rss',
    url: 'https://hnrss.org/newest?points=100&q=frontend+OR+css+OR+html+OR+design+OR+ui+OR+ux+OR+browser+OR+accessibility+OR+mobile',
    includeKeywords: MARKUP_KEYWORDS,
  },
  // 마크업 핵심 (CSS, HTML, 접근성, 웹 디자인)
  {
    name: 'Reddit Web Markup',
    category: 'Reddit',
    type: 'reddit',
    url: 'https://www.reddit.com/r/css+html+accessibility+a11y+web_design/top/.rss?t=day',
  },
  // iOS Safari 이슈 참고용
  {
    name: 'Reddit iOS',
    category: 'Reddit',
    type: 'reddit',
    url: 'https://www.reddit.com/r/ios/top/.rss?t=week',
  },
  // StackOverflow - 공식 API 사용 (Cloudflare 우회)
  {
    name: 'StackOverflow Web',
    category: 'StackOverflow',
    type: 'stackoverflow',
    url: 'css;html;accessibility;a11y',
  },
  {
    name: 'StackOverflow iOS',
    category: 'StackOverflow',
    type: 'stackoverflow',
    url: 'ios;safari',
  },

  // =================================================
  // 2. YouTube (Grouped by Platform)
  // =================================================
  {
    name: 'Kevin Powell',
    category: 'YouTube',
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCJZv4d5rbIKd4QHMPkcABCw',
  },
  {
    name: 'Google Chrome Developers',
    category: 'YouTube',
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCnUYZLuoy1rq1aVMwx4aTzw',
  },
  {
    name: 'Hyperplexed',
    category: 'YouTube',
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmEzz-dPBVrsy4ZluSsYHDg',
  },
  {
    name: 'Deque Systems',
    category: 'YouTube',
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvNQ5aJllZ5Oi49jtMKeb0Q',
  },
  {
    name: 'TPGi',
    category: 'YouTube',
    type: 'youtube',
    url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCmZe7GiM8tY5M8YHSg-Robg',
  },

  // =================================================
  //  YouTube Keywords (API - 발굴 개념 / 비용 100)
  // =================================================
  {
    name: 'YouTube Search',
    category: 'YouTube',
    type: 'youtube_search',
    url: 'html | css | a11y | Web accessibility -"#shorts" -"music" -"mix" -"101" -"beginners"',
  },

  // =================================================
  // 3. Official Blogs (Each Name = Category)
  // =================================================
  {
    name: 'MDN Web Docs',
    category: 'MDN Web Docs',
    type: 'rss',
    url: 'https://developer.mozilla.org/en-US/blog/rss.xml',
  },
  {
    name: 'CSS-Tricks',
    category: 'CSS-Tricks',
    type: 'rss',
    url: 'https://css-tricks.com/feed/',
  },
  {
    name: 'Smashing Magazine',
    category: 'Smashing Magazine',
    type: 'rss',
    url: 'https://www.smashingmagazine.com/feed/',
    useProxy: true,
  },
  // ❌ Apple Developer - Cloud Run IP 차단
  // {
  //   name: 'Apple Developer',
  //   category: 'Apple Developer',
  //   type: 'rss',
  //   url: 'https://developer.apple.com/news/rss/news.rss',
  // },
  {
    name: 'iOS Dev Weekly',
    category: 'iOS Dev Weekly',
    type: 'rss',
    url: 'https://iosdevweekly.com/issues.rss',
  },
  {
    name: 'Swift.org',
    category: 'Swift.org',
    type: 'rss',
    url: 'https://www.swift.org/atom.xml',
  },
  {
    name: 'Android Developers',
    category: 'Android Developers',
    type: 'rss',
    url: 'http://feeds.feedburner.com/blogspot/hsDu',
  },
  {
    name: 'Android Weekly',
    category: 'Android Weekly',
    type: 'rss',
    url: 'https://androidweekly.net/rss.xml',
  },
  {
    name: 'Kotlin Blog',
    category: 'Kotlin Blog',
    type: 'rss',
    url: 'https://blog.jetbrains.com/kotlin/feed/',
  },
  {
    name: 'XDA Developers',
    category: 'XDA Developers',
    type: 'rss',
    url: 'https://www.xda-developers.com/feed/',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'React Blog',
    category: 'React Blog',
    type: 'rss',
    url: 'https://react.dev/rss.xml',
  },
  {
    name: 'WebKit Blog',
    category: 'WebKit Blog',
    type: 'rss',
    url: 'https://webkit.org/blog/feed/',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'Svelte Blog',
    category: 'Svelte Blog',
    type: 'rss',
    url: 'https://svelte.dev/blog/rss.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'web.dev',
    category: 'Google',
    type: 'rss',
    url: 'https://web.dev/static/blog/feed.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'Vercel Blog',
    category: 'Vercel Blog',
    type: 'rss',
    url: 'https://vercel.com/atom',
    includeKeywords: MARKUP_KEYWORDS,
  },
  //Geek News
  {
    name: 'GeekNews',
    category: 'GeekNews',
    type: 'rss',
    url: 'https://feeds.feedburner.com/geeknews-feed',
    includeKeywords: MARKUP_KEYWORDS,
  },

  // =================================================
  // 5. CSS & UI Experts (2026 Active 🔥)
  // =================================================
  {
    name: 'Frontend Masters Boost',
    category: 'Blog',
    type: 'rss',
    url: 'https://frontendmasters.com/blog/feed/',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'Piccalilli (Andy Bell)',
    category: 'Blog',
    type: 'rss',
    url: 'https://piccalil.li/feed.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'CSS Tip (Temani Afif)',
    category: 'Blog',
    type: 'rss',
    url: 'https://css-tip.com/feed/feed.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'nerdy.dev (Adam Argyle)',
    category: 'Blog',
    type: 'rss',
    url: 'https://nerdy.dev/rss.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'Bram.us',
    category: 'Blog',
    type: 'rss',
    url: 'https://www.bram.us/feed/',
    includeKeywords: MARKUP_KEYWORDS,
  },
  {
    name: 'Josh W. Comeau',
    category: 'Blog',
    type: 'rss',
    url: 'https://www.joshwcomeau.com/rss.xml',
    includeKeywords: MARKUP_KEYWORDS,
  },
];
