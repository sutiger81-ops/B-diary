// ─────────────────────────────────────────────────────────────
//  read-label  —  화장품 앞면 사진에서 브랜드·제품명·용량·품번을 뽑는다
//  Supabase Edge Function (Deno)
//
//  [붙여넣기 전에 딱 한 군데만 고치세요]
//    아래 MODEL 값을 Playground 드롭다운에 보이던 모델 이름으로 바꾸세요.
//    (claude-haiku-4-5-2025____ 처럼 뒤에 날짜가 붙습니다. 그대로 복사)
// ─────────────────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `이 화장품 사진에서 아래 항목을 JSON으로만 답해줘. 다른 설명은 쓰지 마.

규칙:
- 사진에 인쇄된 글자를 그대로 옮겨 적어. 번역하지 마.
- 한글 표기와 영문 표기가 둘 다 보이면 둘 다 채워.
- 한쪽만 보이면 보이는 쪽만 채우고 나머지는 null.
- 확실하지 않으면 null. 추측해서 채우지 마.
- 브랜드는 로고가 작거나 용기 아래·구석에 있어도 찾아서 적어. 성분 콜라보 문구(예: CICA×HYALON)는 브랜드가 아니야.
- 가격표 스티커에 품번(숫자)이 보이면 숫자만 적어. 숫자를 한 자리씩 확인하고, 한 자리라도 확실하지 않으면 null.
- 가격표에 가격이 보이면 숫자만 적어 (예: 5000).

{"브랜드_한글":null,"브랜드_영문":null,"제품명_한글":null,"제품명_영문":null,"용량":null,"품번":null,"가격":null}`;

// ── 보호장치 1: 우리 사이트에서 온 호출만 받는다 ──
// 브라우저는 Origin을 속일 수 없어서, 남의 웹페이지가 이 함수를 쓰는 걸 막는다.
const ALLOWED = [
  "https://sutiger81-ops.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function corsFor(origin: string | null) {
  const ok = !!origin && ALLOWED.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED[0],
    "Access-Control-Allow-Headers": "content-type,authorization,apikey",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(origin), "content-type": "application/json; charset=utf-8" },
  });
}

// ── 보호장치 2: 하루 호출 상한 ──
// 같은 서버 인스턴스가 살아있는 동안만 세므로 완벽하진 않지만,
// 한 번에 쏟아지는 호출은 여기서 막힌다.
const DAY_LIMIT = 300;
let dayKey = "";
let dayCount = 0;
function overLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  dayCount++;
  return dayCount > DAY_LIMIT;
}

// 클로드에게 물어보는 부분. 키는 서버 안에만 있고 밖으로 안 나간다.
async function askClaude(key: string, content: unknown[], maxTokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `API 오류 ${r.status}`);
  return data;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsFor(origin) });
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    return json({ ok: false, error: "ANTHROPIC_API_KEY가 설정되지 않았습니다." }, 500, origin);
  }

  // ── 상태 확인 ──
  // 브라우저로 이 주소를 그냥 열면 여기로 옵니다.
  // "키 연결 정상"이 보이면 프로젝트·함수·키가 전부 제대로 붙은 것입니다.
  if (req.method === "GET") {
    try {
      const d = await askClaude(key, [{ type: "text", text: "OK 라고만 답해" }], 16);
      return json({
        ok: true,
        message: "키 연결 정상",
        model: MODEL,
        reply: d?.content?.[0]?.text ?? "",
      }, 200, origin);
    } catch (e) {
      return json({ ok: false, error: String((e as Error).message ?? e) }, 500, origin);
    }
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "POST로 보내세요." }, 405, origin);
  }

  // 우리 사이트가 아닌 곳에서 온 사진 요청은 거절
  if (origin && !ALLOWED.includes(origin)) {
    return json({ ok: false, error: "허용되지 않은 주소에서의 요청입니다." }, 403, origin);
  }

  // 하루 상한
  if (overLimit()) {
    return json({
      ok: false,
      error: "오늘은 사진 읽기를 더 할 수 없습니다. 브랜드나 품번으로 찾아 주세요.",
    }, 429, origin);
  }

  // ── 사진에서 네 칸 뽑기 ──
  try {
    const { image, media_type } = await req.json();
    if (!image) return json({ ok: false, error: "사진(image)이 없습니다." }, 400, origin);
    if (image.length > 7_000_000) {
      return json({ ok: false, error: "사진이 너무 큽니다. 더 작게 찍어 주세요." }, 413, origin);
    }

    const d = await askClaude(
      key,
      [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: media_type ?? "image/jpeg",
            data: image,
          },
        },
        { type: "text", text: PROMPT },
      ],
      300,
    );

    const text: string = d?.content?.[0]?.text ?? "";

    // 모델이 설명을 섞어 보내도 JSON 덩어리만 꺼낸다
    let fields: Record<string, unknown> | null = null;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        fields = JSON.parse(m[0]);
      } catch (_) {
        fields = null;
      }
    }

    return json({
      ok: true,
      fields,          // 네 칸 (못 읽은 칸은 null)
      raw: text,       // 모델이 보낸 원문 (디버깅용)
      usage: d?.usage, // 토큰 사용량 — 사진 한 장에 얼마인지 여기서 확인
    }, 200, origin);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500, origin);
  }
});
