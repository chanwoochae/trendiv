export interface FailedAnalysisResult {
  id: number;
  status: 'FAIL';
  failType:
    | 'PROVIDER_MISMATCH'
    | 'URL_ACCESS_FAIL' // AI가 URL 접근 못함
    | 'CONTENT_BLOCKED' // 차단됨
    | 'API_ERROR' // AI API 자체 에러
    | 'TIMEOUT' // Playwright 타임아웃
    | 'EMPTY_CONTENT' // 본문 추출 실패
    | 'SKIPPED'; // 재시도 횟수 초과 등
  failReason: string;
}

export interface AnalysisResult {
  id?: number;
  aiModel: string;
  score: number;
  reason: string;
  title_ko: string;
  oneLineSummary: string;
  keyPoints: string[];
  tags: string[];
  analyzedAt: string;
  content?: string;
}

export interface Trend {
  id: number;
  title: string;
  link: string;
  date: string;
  source: string;
  category: string;
  analysis_results?: AnalysisResult[];
  represent_result?: AnalysisResult | null;
  content?: string;
  content_raw?: string;
  report_html?: string | null;
}

export interface PipelineResult extends AnalysisResult {
  id: number;
  originalLink: string;
  date: string;
}

export interface GeminiAnalysisResponse {
  score: number;
  reason: string;
  title_ko: string;
  oneLineSummary: string;
  keyPoints: string[];
  tags: string[];
}

export type ContentType = 'youtube' | 'webpage';

export interface ContentFetchResult {
  content: string;
  type: ContentType;
  source: 'transcript' | 'description' | 'webpage';
}
