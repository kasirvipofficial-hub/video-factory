import axios from 'axios';
import { log } from '../utils/logger';
import { ENV } from '../config/env';
import { ClipCustomization } from '../queue/queues';

export interface HighlightSegment {
    start: number;
    end: number;
    reason: string;
    action: 'hook' | 'keep' | 'discard';
    narrativeText?: string | null;
    needsTTS?: boolean;
}

export interface FactualEvent {
    start: number;
    end: number;
    speaker: string;
    transcriptText: string;
    visualContext: string;
    emotionalTone: string;
}

export interface AnalysisResult {
    title: string;
    summary: string;
    highlights: HighlightSegment[];
    keyMoments: string[];
    suggestedNarrative: string;
    transcriptSummary: string;
}

export interface CandidateRerankResult {
    topicId: string;
    scoreAdjustment: number;
    reason: string;
}

export interface DiscoveryWindow {
    windowId: string;
    start: number;
    end: number;
    duration: number;
    transcriptExcerpt: string;
    audioScore: number;
    peakCount: number;
    heuristicScore: number;
}

export interface TopicDiscoveryCandidate {
    title: string;
    start: number;
    end: number;
    summary: string;
    hook: string;
    whyItCanSpread: string;
    primaryEmotion: string;
    reasonTags: string[];
    scoreViral: number;
    confidence: number;
}

export interface PublishMetadata {
    postingTitle: string;
    caption: string;
    hashtags: string[];
}

export class AIAnalyzer {
    private static normalizeHashtag(value: string): string {
        const trimmed = value.trim();
        if (!trimmed) {
            return '';
        }

        const withoutHash = trimmed.replace(/^#+/, '');
        const compact = withoutHash.replace(/[^a-zA-Z0-9_]/g, '');
        return compact ? `#${compact}` : '';
    }

    private static buildPublishFallback(
        sourceTitle: string,
        summary: string,
        customization?: ClipCustomization
    ): PublishMetadata {
        const platform = customization?.targetPlatform || 'general';
        const audience = customization?.targetAudience ? ` untuk ${customization.targetAudience}` : '';
        const tone = customization?.postingTone ? ` dengan tone ${customization.postingTone}` : '';
        const baseTitle = sourceTitle.trim() || 'Highlight Video';
        const postingTitle = baseTitle.length > 90 ? `${baseTitle.slice(0, 87).trim()}...` : baseTitle;
        const summaryLine = summary.trim() || 'Potongan paling penting dari video sumber.';
        const callToAction = customization?.callToAction?.trim() || 'Tulis pendapatmu di komentar.';
        const defaultTags = [platform, 'clipper', 'shorts', 'viral'];
        const mergedTags = [...(customization?.hashtags || []), ...defaultTags]
            .map((tag) => this.normalizeHashtag(tag))
            .filter(Boolean)
            .filter((tag, index, all) => all.indexOf(tag) === index)
            .slice(0, 8);

        return {
            postingTitle,
            caption: `${summaryLine}${audience}${tone}. ${callToAction}`.trim(),
            hashtags: mergedTags
        };
    }

    private static buildTranscriptFallbackEvents(formattedTranscript: string): FactualEvent[] {
        if (!formattedTranscript || !formattedTranscript.trim()) {
            return [];
        }

        const lines = formattedTranscript
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .slice(0, 120);

        const events: FactualEvent[] = [];
        for (const line of lines) {
            const m = line.match(/^\[(\d+(?:\.\d+)?)s\s*-\s*(\d+(?:\.\d+)?)s\]\s*(.+)$/);
            if (!m) continue;
            events.push({
                start: Number(m[1]),
                end: Number(m[2]),
                speaker: 'Speaker',
                transcriptText: m[3],
                visualContext: 'Unknown (fallback transcript-only mode)',
                emotionalTone: 'Unknown'
            });
        }

        return events;
    }

    /**
     * PHASE 1: Data Agent
     * Extract pure chronological facts, transcripts, and visual contexts from the video.
     */
    static async analyzeData(videoTitle: string, videoUrl: string, formattedTranscript: string): Promise<FactualEvent[]> {
        log.info({ videoTitle }, '🕵️‍♂️ Phase 1: Data Agent Analysis starting');
        const maxAttempts = 2;
        let response: any = null;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
            const prompt = `
You are a meticulous Data Analyst and Video Logger.
Your ONLY job is to extract factual data from the provided video and its text transcript.
Do not act as a director or editor. Just log the facts.

OUTPUT A JSON OBJECT strictly matching this TypeScript interface:
{
    "events": [
        {
            "start": number, // start time in seconds
            "end": number, // end time in seconds
            "speaker": string, // "Main Host", "Guest 1", "Crowd", etc.
            "transcriptText": string, // The exact words spoken during this time window
            "visualContext": string, // What is physically happening on screen? (e.g. "Host holding a product", "Camera zooming in")
            "emotionalTone": string // e.g. "Happy", "Angry", "Calm", "Silent"
        }
    ]
}

Break the video down into chronological chunks of 20-40 seconds. Be concise in your descriptions. Ensure the entire video timeline is covered from start to finish.
`;

            response = await axios.post(
                `${ENV.AI_API_BASE_URL}/chat/completions`,
                {
                    model: ENV.AI_MODEL,
                    messages: [
                        { role: 'system', content: 'You are an objective and highly detailed video data logger. You perceive both video and text.' },
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt + '\n\nTITLE: ' + videoTitle + '\n\nTRANSCRIPT:\n' + formattedTranscript },
                                { type: 'video_url', video_url: { url: videoUrl } }
                            ]
                        }
                    ],
                    response_format: { type: 'json_object' },
                    max_tokens: 4096
                },
                {
                    headers: { 'Authorization': `Bearer ${ENV.AI_API_KEY}`, 'Content-Type': 'application/json' },
                    timeout: ENV.AI_DATA_TIMEOUT_MS
                }
            );

            const resultText = response.data.choices[0]?.message?.content;
            
            if (!resultText) {
                log.warn({}, '⚠️ Empty response from Data Agent API, returning fallback');
                return [];
            }
            
            // Remove markdown code blocks if present
            let jsonStr = resultText.trim();
            if (jsonStr.startsWith('```')) {
                // Extract JSON from markdown code block
                const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                if (match) {
                    jsonStr = match[1].trim();
                }
            }
            
            // Validate JSON before parsing
            if (!jsonStr || jsonStr.length === 0) {
                log.warn({}, '⚠️ Empty JSON string from Data Agent, returning fallback');
                return [];
            }
            
            const parsed = JSON.parse(jsonStr);

            if (!parsed.events || !Array.isArray(parsed.events)) {
                log.warn({ parsed }, '⚠️ Invalid events structure, returning fallback');
                return this.buildTranscriptFallbackEvents(formattedTranscript);
            }

            return parsed.events;
            } catch (error: any) {
                lastErr = error;
                log.warn(
                    { attempt, maxAttempts, err: error.message, apiResponse: response?.data },
                    '⚠️ Data Agent attempt failed'
                );
            }
        }

        log.error({ err: lastErr?.message }, '❌ Data Agent Phase failed - using transcript fallback');
        return this.buildTranscriptFallbackEvents(formattedTranscript);
    }

    static async generatePublishMetadata(
        sourceTitle: string,
        analysisMarkdown: string,
        selectionSummary: string,
        customization?: ClipCustomization
    ): Promise<PublishMetadata> {
        const fallback = this.buildPublishFallback(sourceTitle, selectionSummary, customization);

        if (!ENV.AI_API_KEY) {
            return fallback;
        }

        const maxAttempts = 2;
        let response: any = null;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const prompt = `
You are a social media editor preparing a publish-ready package for a vertical short clip.

Return a JSON object with this exact shape:
{
  "postingTitle": string,
  "caption": string,
  "hashtags": string[]
}

Rules:
- postingTitle must be punchy, specific, and under 90 characters
- caption must be 1 short paragraph, natural Indonesian unless customization explicitly requests another language
- hashtags must contain 4-8 tags, no duplicates, each starting with #
- use the customization request when present
- do not use clickbait that is unsupported by the analysis

SOURCE TITLE: ${sourceTitle}
CUSTOMIZATION: ${JSON.stringify(customization || {}, null, 2)}
SELECTION SUMMARY: ${selectionSummary}

ANALYSIS MARKDOWN:
${analysisMarkdown.slice(0, 6000)}
`;

                response = await axios.post(
                    `${ENV.AI_API_BASE_URL}/chat/completions`,
                    {
                        model: ENV.AI_MODEL,
                        messages: [
                            {
                                role: 'system',
                                content: 'You generate platform-ready social copy for short video clips.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        response_format: { type: 'json_object' },
                        max_tokens: 1200
                    },
                    {
                        headers: { 'Authorization': `Bearer ${ENV.AI_API_KEY}`, 'Content-Type': 'application/json' },
                        timeout: ENV.AI_DIRECTOR_TIMEOUT_MS
                    }
                );

                const resultText = response.data.choices[0]?.message?.content;
                if (!resultText) {
                    return fallback;
                }

                let jsonStr = resultText.trim();
                if (jsonStr.startsWith('```')) {
                    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                    if (match) {
                        jsonStr = match[1].trim();
                    }
                }

                const parsed = JSON.parse(jsonStr);
                const hashtags = Array.isArray(parsed.hashtags)
                    ? parsed.hashtags
                        .map((tag: unknown) => this.normalizeHashtag(String(tag || '')))
                        .filter(Boolean)
                        .filter((tag: string, index: number, all: string[]) => all.indexOf(tag) === index)
                        .slice(0, 8)
                    : fallback.hashtags;

                return {
                    postingTitle: String(parsed.postingTitle || fallback.postingTitle).slice(0, 90).trim() || fallback.postingTitle,
                    caption: String(parsed.caption || fallback.caption).trim() || fallback.caption,
                    hashtags: hashtags.length > 0 ? hashtags : fallback.hashtags
                };
            } catch (error: any) {
                lastErr = error;
                log.warn(
                    { attempt, maxAttempts, err: error.message, apiResponse: response?.data },
                    '⚠️ Publish metadata generation attempt failed'
                );
            }
        }

        log.warn({ err: lastErr?.message }, 'Publish metadata generation failed, using fallback');
        return fallback;
    }

    static async rerankCandidatesWithVision(
        videoTitle: string,
        videoUrl: string,
        candidates: Array<{ topicId: string; start: number; end: number; summary: string; scoreViral: number }>
    ): Promise<CandidateRerankResult[]> {
        if (!videoUrl || candidates.length === 0) {
            return [];
        }

        const maxAttempts = 2;
        let response: any = null;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const prompt = `
You are a short-form video scout reviewing ONLY a few candidate segments.
Use the video preview to lightly rerank the candidates based on visible emotional intensity, reaction value, and visual hook strength.
Do NOT invent new candidates. Only score the candidates provided.

Return a JSON object with this exact shape:
{
  "candidates": [
    {
      "topicId": string,
      "scoreAdjustment": number,
      "reason": string
    }
  ]
}

Rules:
- scoreAdjustment must be between -15 and 15
- prefer small changes unless the visual difference is obvious
- if visual evidence is weak, use 0

CANDIDATES:
${JSON.stringify(candidates, null, 2)}
`;

                response = await axios.post(
                    `${ENV.AI_API_BASE_URL}/chat/completions`,
                    {
                        model: ENV.AI_MODEL,
                        messages: [
                            {
                                role: 'system',
                                content: 'You rerank a short list of candidate segments using light visual judgment only.'
                            },
                            {
                                role: 'user',
                                content: [
                                    { type: 'text', text: prompt + `\n\nTITLE: ${videoTitle}` },
                                    { type: 'video_url', video_url: { url: videoUrl } }
                                ]
                            }
                        ],
                        response_format: { type: 'json_object' },
                        max_tokens: 1200
                    },
                    {
                        headers: { 'Authorization': `Bearer ${ENV.AI_API_KEY}`, 'Content-Type': 'application/json' },
                        timeout: ENV.AI_DATA_TIMEOUT_MS
                    }
                );

                const resultText = response.data.choices[0]?.message?.content;
                if (!resultText) {
                    return [];
                }

                let jsonStr = resultText.trim();
                if (jsonStr.startsWith('```')) {
                    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                    if (match) {
                        jsonStr = match[1].trim();
                    }
                }

                const parsed = JSON.parse(jsonStr);
                if (!Array.isArray(parsed.candidates)) {
                    return [];
                }

                return parsed.candidates
                    .filter((candidate: any) => candidate && typeof candidate.topicId === 'string')
                    .map((candidate: any) => ({
                        topicId: candidate.topicId,
                        scoreAdjustment: Math.max(-15, Math.min(15, Number(candidate.scoreAdjustment) || 0)),
                        reason: String(candidate.reason || 'Vision rerank')
                    }));
            } catch (error: any) {
                lastErr = error;
                log.warn(
                    { attempt, maxAttempts, err: error.message, apiResponse: response?.data },
                    '⚠️ Vision rerank attempt failed'
                );
            }
        }

        log.warn({ err: lastErr?.message }, 'Vision rerank disabled by failure, using transcript/audio ranking only');
        return [];
    }

    static async discoverViralTopics(
        videoTitle: string,
        videoDuration: number,
        windows: DiscoveryWindow[]
    ): Promise<{ topics: TopicDiscoveryCandidate[]; markdown: string }> {
        if (windows.length === 0) {
            return {
                topics: [],
                markdown: '# Topic Discovery\n\nNo discovery windows were available.'
            };
        }

        const maxAttempts = 2;
        let response: any = null;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const prompt = `
You are an elite long-form to short-form content strategist.
Your job is to scout the BEST candidate topics from a long source video for 1-3 minute viral shorts.

You are NOT making the final edit yet.
You are deciding which TOPICS are worth extracting.

PRIMARY GOAL:
- Find 4-7 distinct topics with the strongest viral potential.
- Prioritize topics that can stand alone and immediately feel worth watching.

LOOK FOR:
- revelations, accusations, conflict, contradiction, tension, stakes
- emotionally charged statements or reactions
- surprising facts or sharp opinion pivots
- highly quotable moments
- useful insight with a strong payoff
- topics that can hook in the first 3-8 seconds and still sustain attention up to 60-180 seconds

PRIORITIZE THESE VIRAL PATTERNS:
- conflict: argument, attack, rebuttal, controversy, exposed contradiction
- novelty: unexpected fact, surprising angle, counter-intuitive framing, new insight
- authority clash: respected figures or institutions disagreeing, challenging, exposing, or undercutting each other
- strong takeaway: clear consequence, conclusion, verdict, warning, lesson, or punchline that lands hard

REJECT:
- greetings, intros, housekeeping, vague setup, repetitive explanation, low-stakes commentary
- topics needing too much external context before they become interesting
- multiple candidates that are basically the same topic

WORKING RULES:
- Use ONLY evidence from the provided windows.
- You may merge adjacent windows when needed, but do not invent timestamps outside the available material.
- Prefer candidates roughly 45-180 seconds long.
- Candidates must be materially different from each other.
- Rank by viral potential, not chronology.

Return a JSON object with this exact shape:
{
  "topics": [
    {
      "title": string,
      "start": number,
      "end": number,
      "summary": string,
      "hook": string,
      "whyItCanSpread": string,
      "primaryEmotion": string,
      "reasonTags": string[],
      "scoreViral": number,
      "confidence": number
    }
  ],
  "markdownReport": string
}

SCORING EXPECTATION:
- scoreViral 90-100 only if the topic has a powerful hook, clear stakes, and a satisfying payoff
- confidence must be 0.0-1.0
- keep reasons concrete and editorial, not generic
- explicitly reward candidates that show one or more of: conflict, novelty, authority clash, strong takeaway

SOURCE TITLE: ${videoTitle}
SOURCE DURATION: ${videoDuration} seconds

DISCOVERY WINDOWS:
${JSON.stringify(windows, null, 2)}
`;

                response = await axios.post(
                    `${ENV.AI_API_BASE_URL}/chat/completions`,
                    {
                        model: ENV.AI_MODEL,
                        messages: [
                            {
                                role: 'system',
                                content: 'You identify high-viral-potential topics from long videos with disciplined editorial judgment.'
                            },
                            {
                                role: 'user',
                                content: prompt
                            }
                        ],
                        response_format: { type: 'json_object' },
                        max_tokens: 3200
                    },
                    {
                        headers: { 'Authorization': `Bearer ${ENV.AI_API_KEY}`, 'Content-Type': 'application/json' },
                        timeout: ENV.AI_DIRECTOR_TIMEOUT_MS
                    }
                );

                const resultText = response.data.choices[0]?.message?.content;
                if (!resultText) {
                    return {
                        topics: [],
                        markdown: '# Topic Discovery\n\nEmpty response from AI topic scout.'
                    };
                }

                let jsonStr = resultText.trim();
                if (jsonStr.startsWith('```')) {
                    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                    if (match) {
                        jsonStr = match[1].trim();
                    }
                }

                const parsed = JSON.parse(jsonStr);
                if (!Array.isArray(parsed.topics)) {
                    return {
                        topics: [],
                        markdown: parsed.markdownReport || '# Topic Discovery\n\nAI returned invalid topic structure.'
                    };
                }

                const topics = parsed.topics
                    .filter((topic: any) => topic)
                    .map((topic: any) => ({
                        title: String(topic.title || 'Untitled topic'),
                        start: Number(topic.start) || 0,
                        end: Number(topic.end) || 0,
                        summary: String(topic.summary || ''),
                        hook: String(topic.hook || ''),
                        whyItCanSpread: String(topic.whyItCanSpread || ''),
                        primaryEmotion: String(topic.primaryEmotion || 'Unknown'),
                        reasonTags: Array.isArray(topic.reasonTags)
                            ? topic.reasonTags.map((tag: unknown) => String(tag)).filter(Boolean).slice(0, 6)
                            : [],
                        scoreViral: Math.max(0, Math.min(100, Number(topic.scoreViral) || 0)),
                        confidence: Math.max(0, Math.min(1, Number(topic.confidence) || 0))
                    }))
                    .filter((topic: TopicDiscoveryCandidate) => topic.end > topic.start && topic.summary);

                return {
                    topics,
                    markdown: parsed.markdownReport || '# Topic Discovery\n\nAI topic scout completed.'
                };
            } catch (error: any) {
                lastErr = error;
                log.warn(
                    { attempt, maxAttempts, err: error.message, apiResponse: response?.data },
                    '⚠️ Topic discovery attempt failed'
                );
            }
        }

        log.warn({ err: lastErr?.message }, 'AI topic discovery failed, using transcript/audio heuristics only');
        return {
            topics: [],
            markdown: '# Topic Discovery\n\nAI topic scout failed; falling back to transcript/audio heuristics.'
        };
    }

    /**
     * PHASE 2: Director Agent
     * Act as an elite short-form video producer to craft a viral clip from factual data.
     */
    static async directViralClip(videoTitle: string, factualData: FactualEvent[]): Promise<{ highlights: HighlightSegment[]; markdown: string }> {
        log.info({ videoTitle }, '🎬 Phase 2: Director Agent Planning starting');
        if (!factualData || factualData.length === 0) {
            return {
                highlights: [],
                markdown: '# Director\'s Cut\n\nFallback mode: no factual events, pipeline will use automatic cuts.'
            };
        }

        const maxAttempts = 2;
        let response: any = null;
        let lastErr: any = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
            const prompt = `
You are an elite TikTok/Reels Video Director and Producer with a multi-million follower streak.
You are given a highly detailed, chronological Factual Data Report of a video.
Your job is to architect the ultimate viral, 60-180 second vertical short-form video.

CRITICAL CUTTING RULES (NON-NEGOTIABLE):
1. NEVER cut in the middle of a sentence or while someone is speaking
2. Cut ONLY at natural sentence boundaries or between speakers
3. Avoid cutting during high emotional moments (angry, excited, shocked tones)
4. Discard dead air, pauses, and transitional moments where nothing happens
5. Keep "active speaking" segments intact - don't interrupt dialogue mid-word

YOUR STRATEGY:
1. THE HOOK (First 3 seconds): Find the most INTERESTING moment. Look for:
   - Strong emotional tone (Angry, Excited, Shocked, Emotional)
   - Impressive statements or revelations
   - Provocative or engaging speech
   - High-energy delivery
   Mark this as 'hook' action and place it at the beginning.

2. IDENTIFYING INTERESTING MOMENTS: Highlight words/phrases should come from:
   - Strong emotional tone indicators
   - Transition between different speakers or topics
   - Key declarative statements
   - These will be used for karaoke word-level highlighting

3. THE PACING: Discard boring parts:
   - Long pauses (silence periods)
   - Filler words or dead air
   - Repetitive explanations
   - Transitional "hmm, let me think" moments

4. SENTENCE BOUNDARIES: Ensure each 'keep' segment:
   - Starts at the beginning of a sentence or speaker's turn
   - Ends at the end of a sentence or natural pause
   - Contains complete thoughts from the speaker
   - Does NOT cut mid-sentence or mid-word

5. BRIDGES: If you discard large chunks, use 'narrativeText' (1-2 sentence TTS voiceover) to bridge.
   - Keep bridges very brief

6. NARRATIVE ARC:
    - Build a clear sequence: hook -> escalation -> payoff.
    - The first segment must create immediate curiosity or tension.
    - The middle segments should deepen the conflict, reveal, or analysis.
    - The last kept segment should land a payoff, punchline, consequence, or takeaway.

7. VIRAL QUALITY BAR:
    - Prefer moments people would quote, argue about, forward, or clip independently.
    - Reward confrontation, sharp framing, clear stakes, memorable language, or a surprising turn.
    - Avoid segments that are merely informative if they lack tension or payoff.

8. AVOID GENERIC OUTPUT:
    - NEVER return equally-sized segments across the whole video.
    - Segment durations must vary naturally based on topic intensity.
    - Prefer 3-6 meaningful segments with mixed lengths (example: 18s, 42s, 27s, 55s), not fixed patterns.
    - Maximize topic diversity: if multiple viral subtopics exist, include different subtopics in keep/hook segments.

9. DURATION QUALITY:
    - Each keep/hook segment should generally be 20-120 seconds.
    - Avoid tiny fragments under 8 seconds unless it is a very strong hook.
    - Avoid overlong monolithic segments above 180 seconds.

10. OUTPUT DISCIPLINE:
     - The returned segments must already reflect a coherent final short, not a raw list of interesting moments.
     - The 'reason' field must mention why the segment earns its place in the viral arc.
     - Use 'discard' aggressively for setup that does not improve hook, escalation, or payoff.

OUTPUT A JSON OBJECT strictly matching this structure:
{
    "segments": [
        {
            "start": number,  // from the factual data
            "end": number,    // from the factual data
            "action": "hook" | "keep" | "discard",
            "reason": string, // Explain cut decision: Why? Emotional tone? Sentence boundary?
            "narrativeText": string | null, // TTS bridge text (1-2 sentences max, 10-15 words)
            "needsTTS": boolean,
            "viralScore": number // 0-100, confidence of virality for this segment
        }
    ],
    "markdownReport": string // Detailed markdown explaining creative vision, pacing, and cut strategy
}

FACTUAL DATA REPORT:
${JSON.stringify(factualData, null, 2)}
`;

            response = await axios.post(
                `${ENV.AI_API_BASE_URL}/chat/completions`,
                {
                    model: ENV.AI_MODEL,
                    messages: [
                        { role: 'system', content: "You are the world's greatest, most creative viral video editor and director." },
                        { role: 'user', content: prompt }
                    ],
                    response_format: { type: 'json_object' },
                    max_tokens: 4096
                },
                {
                    headers: { 'Authorization': `Bearer ${ENV.AI_API_KEY}`, 'Content-Type': 'application/json' },
                    timeout: ENV.AI_DIRECTOR_TIMEOUT_MS
                }
            );

            const resultText = response.data.choices[0]?.message?.content;
            
            if (!resultText) {
                log.warn({}, '⚠️ Empty response from Director Agent API, returning fallback');
                return {
                    highlights: [],
                    markdown: '# Director\'s Cut\n\nVideo processing completed.'
                };
            }
            
            // Remove markdown code blocks if present
            let jsonStr = resultText.trim();
            if (jsonStr.startsWith('```')) {
                // Extract JSON from markdown code block
                const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
                if (match) {
                    jsonStr = match[1].trim();
                }
            }
            
            // Validate JSON before parsing
            if (!jsonStr || jsonStr.length === 0) {
                log.warn({}, '⚠️ Empty JSON string from Director Agent, returning fallback');
                return {
                    highlights: [],
                    markdown: '# Director\'s Cut\n\nVideo processing completed.'
                };
            }
            
            const parsed = JSON.parse(jsonStr);

            if (!parsed.segments) {
                log.warn({ parsed }, '⚠️ Invalid segments structure, returning fallback');
                return {
                    highlights: [],
                    markdown: parsed.markdownReport || '# Director\'s Cut\n\nVideo processing completed.'
                };
            }

            return {
                highlights: parsed.segments,
                markdown: parsed.markdownReport || '# Director\'s Cut\n\nVideo processing completed.'
            };

            } catch (error: any) {
                lastErr = error;
                log.warn(
                    { attempt, maxAttempts, err: error.message, apiResponse: response?.data },
                    '⚠️ Director Agent attempt failed'
                );
            }
        }

        log.error({ err: lastErr?.message }, '❌ Director Agent Phase failed - using fallback');
        return {
            highlights: [],
            markdown: '# Director\'s Cut\n\nVideo processing completed.'
        };
    }
}
