import { PUBLIC_API_URL } from '$env/static/public';
import { supabase } from '$lib/stores/db';
import type { Trend } from '$lib/types';
import type { PageLoad } from './$types';

interface TagRank {
	tag: string;
	score: number;
}

// supabase 클라이언트 가져오기

export const load: PageLoad = async ({ fetch }) => {
	// 1. 카테고리 가져오기 함수
	const fetchCategories = async () => {
		const { data, error } = await supabase
			.from('article')
			.select('category')
			.eq('status', 'ANALYZED');

		if (error || !data) return [];

		const unique = [...new Set(data.map((d) => d.category))];
		return unique.filter(Boolean); // 혹시 모를 null/빈값 제거
	};

	// 2. 인기 태그 가져오기 함수
	const fetchPopularTags = async () => {
		const FIXED_TAGS = ['HTML', 'CSS', 'Accessibility'];
		const now = new Date();
		const twoWeeksAgo = new Date(
			new Date().setDate(now.getDate() - 14)
		).toISOString();
		const sixMonthsAgo = new Date(
			new Date().setMonth(now.getMonth() - 6)
		).toISOString();
		const today = now.toISOString();

		try {
			const { data: recentData } = await supabase.rpc('get_popular_tags', {
				start_date: twoWeeksAgo,
				end_date: today,
				limit_count: 3,
				exclude_tags: FIXED_TAGS
			});

			// 이제 any 없이도 타입 추론 완벽 동작
			const recentTags =
				(recentData as TagRank[] | null)?.map((t) => t.tag) || [];

			const excludeForLongTerm = [...FIXED_TAGS, ...recentTags];

			const { data: longTermData } = await supabase.rpc('get_popular_tags', {
				start_date: sixMonthsAgo,
				end_date: today,
				limit_count: 3,
				exclude_tags: excludeForLongTerm
			});

			const longTermTags =
				(longTermData as TagRank[] | null)?.map((t) => t.tag) || [];

			return [...FIXED_TAGS, ...recentTags, ...longTermTags];
		} catch (e) {
			console.error('태그 로딩 실패:', e);
			return FIXED_TAGS;
		}
	};

	try {
		const [trendsRes, categories, popularTags] = await Promise.all([
			fetch(`${PUBLIC_API_URL || 'http://127.0.0.1:3000'}/api/trends?limit=20`),
			fetchCategories(),
			fetchPopularTags()
		]);

		let trends: Trend[] = [];
		if (trendsRes.ok) {
			const result = await trendsRes.json();
			if (result.success) trends = result.data;
		}

		// 3. 페이지로 데이터 전달
		return {
			trends,
			categories,
			popularTags
		};
	} catch (err) {
		console.error('❌ 데이터 로딩 실패:', err);
		return {
			trends: [],
			categories: [],
			popularTags: ['HTML', 'CSS', 'Accessibility']
		};
	}
};
