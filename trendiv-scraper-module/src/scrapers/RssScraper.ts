import Parser from 'rss-parser';
import axios from 'axios';
import { Browser } from 'playwright';
import { CONFIG, getRandomContextOptions } from '../config/config';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Scraper, ScraperConfig, TrendItem } from './interface';

// rss2json 응답 타입
interface Rss2JsonItem {
  title: string;
  link: string;
  pubDate: string;
  description?: string;
  content?: string;
}

interface Rss2JsonResponse {
  status: string;
  items: Rss2JsonItem[];
}

chromium.use(stealth());

export class RssScraper implements Scraper {
  private parser = new Parser();
  private readonly RSS2JSON_API = 'https://api.rss2json.com/v1/api.json';

  constructor(private browser?: Browser) {}

  async scrape(config: ScraperConfig): Promise<TrendItem[]> {
    console.log(`📡 [RSS] ${config.name} 수집 시작...`);

    // 프록시 모드
    if (config.useProxy) {
      return this.fetchWithProxy(config);
    }

    // 기존 로직
    let xmlData = '';

    console.log(`📡 [RSS] ${config.name} 수집 시작...`);

    try {
      console.log(`   try: 1차 Axios 요청 시도 (${config.url})...`);
      const response = await axios.get(config.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        timeout: 30000,
        responseType: 'text',
      });
      xmlData = response.data;
      console.log(`   ✅ 1차 Axios 성공`);
    } catch (error: any) {
      console.log(
        `   ⚠️ 1차 요청 실패: ${error.response?.status || error.message}`,
      );
      if (
        error.response &&
        (error.response.status === 406 || error.response.status === 403)
      ) {
        console.log(
          `⚠️ [RSS] ${config.name} 보안 감지! 브라우저 모드로 우회합니다...`,
        );
        xmlData = await this.fetchWithBrowser(config.url);
      }
    }

    if (!xmlData) return [];

    try {
      const cleanXml = xmlData
        .toString()
        .trim()
        .replace(/^\uFEFF/, '')
        .replace(/<(?=\s|[0-9])/g, '&lt;');
      const feed = await this.parser.parseString(cleanXml);

      // 1. 데이터 매핑
      const items = feed.items.map((item) => {
        const content =
          item.contentSnippet || item.content || item.summary || '';
        const date = item.isoDate || item.pubDate || null;

        return {
          title: item.title?.trim() || '제목 없음',
          link: item.link || '',
          date: date,
          source: config.name,
          category: config.category,
          content: content,
        };
      });

      // 2. 필터링
      if (config.includeKeywords && config.includeKeywords.length > 0) {
        const filtered = items.filter((item) => {
          const textToCheck = (item.title + ' ' + item.content).toLowerCase();

          // 하나라도 포함되어 있으면 통과 (OR 조건)
          const isMatched = config.includeKeywords?.some((keyword) =>
            textToCheck.includes(keyword.toLowerCase()),
          );

          return isMatched;
        });

        console.log(
          `   ✨ Keyword Filter: ${items.length} -> ${filtered.length} items`,
        );
        return filtered;
      }

      return items;
    } catch (parseError) {
      console.error(`❌ [RSS] ${config.name} 파싱 에러:`, parseError);
      return [];
    }
  }

  private async fetchWithProxy(config: ScraperConfig): Promise<TrendItem[]> {
    console.log(`   🔄 Using rss2json proxy...`);

    try {
      const response = await axios.get<Rss2JsonResponse>(this.RSS2JSON_API, {
        params: {
          rss_url: config.url,
        },
        timeout: 30000,
      });

      if (response.data.status !== 'ok') {
        console.error(
          `❌ [RSS Proxy] ${config.name} 실패: ${response.data.status}`,
        );
        return [];
      }

      const items = response.data.items.map((item) => ({
        title: item.title?.trim() || '제목 없음',
        link: item.link || '',
        date: item.pubDate || null,
        source: config.name,
        category: config.category,
        content: item.description || item.content || '',
      }));

      console.log(`   ✅ Proxy success: ${items.length}개 수집`);
      return items;
    } catch (error: any) {
      console.error(`❌ [RSS Proxy] ${config.name} 실패: ${error.message}`);
      return [];
    }
  }

  private async fetchWithBrowser(url: string): Promise<string> {
    console.log(`   🚀 [Browser] 브라우저 실행 준비...`);

    let localBrowser: Browser | null = null;
    let browserToUse = this.browser;

    if (!browserToUse) {
      console.log(`   🆕 [Browser] 새 인스턴스 런치 시작...`);
      localBrowser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--disable-images',
          '--disable-extensions',
          '--disable-blink-features=AutomationControlled',
        ],
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: '/dev/null',
        },
      });
      browserToUse = localBrowser;
    }

    let context;
    let page;

    try {
      context = await browserToUse.newContext(getRandomContextOptions());

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      page = await context.newPage();

      await page.route('**/*', async (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const reqUrl = request.url().toLowerCase();

        // 1. 불필요한 리소스 차단 (이미지, 폰트, 미디어, 스타일)
        if (['image', 'font', 'media', 'imageset'].includes(resourceType)) {
          return await route.abort();
        }

        // 2. 네트워크를 붙잡고 있는 광고/채팅/분석 도구 키워드 차단
        const blockList = [
          'googleadservices',
          'googlesyndication',
          'doubleclick', // 구글 광고
          'google-analytics',
          'googletagmanager', // 분석 도구
          'facebook',
          'twitter',
          'linkedin', // 소셜 추적기
          'intercom',
          'zendesk',
          'crisp',
          'channel.io', // 채팅 위젯
          'hotjar',
          'sentry',
          'datadog', // 모니터링 툴
          'adsystem',
          'adserver', // 일반 광고
        ];

        // URL에 차단 키워드가 포함되어 있으면 즉시 연결 끊기
        if (blockList.some((keyword) => reqUrl.includes(keyword))) {
          return await route.abort();
        }

        // 나머지는 통과
        return await route.continue();
      });

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.browser.timeout,
      });

      const text = (await response?.text()) || '';

      if (!text) throw new Error('No response');
      return text;
    } catch (e) {
      console.error(`❌ 브라우저 모드 실패:`, e);
      return '';
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});

      if (localBrowser) {
        await localBrowser.close();
      }
    }
  }
}
