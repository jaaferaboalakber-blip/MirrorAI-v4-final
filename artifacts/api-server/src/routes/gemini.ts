import { GoogleGenAI } from "@google/genai";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const MODEL = "gemini-3.6-flash";
const MAX_INPUT = 220_000;

const BASE_INSTRUCTIONS = `أنت «مرآة الأسلوب»: محلل محادثات دقيق. تدرس النص والسياق والأنماط المتكررة، ولا تدّعي قراءة الأفكار أو معرفة النوايا الداخلية. افصل الدليل عن الاستنتاج. لا تشخّص نفسياً ولا تحكم أخلاقياً ولا تحاول إثارة الغيرة أو الشك. لا تجعل نمطاً عابراً صفة ثابتة. عند تعارض القرائن اذكر التعارض. استخدم العربية العراقية الطبيعية عندما تناسب المستخدم. احترم الخصوصية ولا تطلب بيانات لا تحتاجها.`;

type Message = {
  date?: string;
  time?: string;
  speaker?: string;
  text?: string;
};

type Memory = {
  title?: string;
  category?: string;
  trigger?: string;
  context?: string;
  herMessage?: string;
  responsePattern?: string;
  keywords?: string[];
  evidence?: string;
  confidence?: number;
};

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

function safe(value: unknown, limit = MAX_INPUT) {
  return String(value ?? "").slice(0, limit);
}

function parseJson(text: string) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("تعذر قراءة استجابة Gemini بصيغة JSON.");
  }
}

function aiUnavailable(res: Response) {
  if (getClient()) return false;
  res.status(503).json({
    error: "الذكاء الاصطناعي غير مفعّل. أضف GEMINI_API_KEY في Secrets.",
  });
  return true;
}

async function generate(prompt: string, json = false) {
  const client = getClient();
  if (!client) throw new Error("GEMINI_API_KEY غير مفعّل.");
  const response = await client.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: json ? { responseMimeType: "application/json", maxOutputTokens: 8192 } : { maxOutputTokens: 8192 },
  });
  return response.text || "";
}

function logError(req: Request, error: unknown) {
  req.log.error({ err: error }, "Gemini request failed");
}

router.post("/profile", async (req, res) => {
  if (aiUnavailable(res)) return;
  try {
    const { herName, messages = [], mode, participants = [] } = req.body as {
      herName?: string;
      messages?: Message[];
      mode?: string;
      participants?: string[];
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "لا توجد رسائل كافية لبناء البصمة." });
    }
    const sample = messages
      .map((message, index) => `${index}|${safe(message.date, 40)} ${safe(message.time, 40)}|${safe(message.speaker, 120)}|${safe(message.text, 1000)}`)
      .join("\n")
      .slice(0, MAX_INPUT);
    if (mode === "participant-batch" && Array.isArray(participants) && participants.length > 0) {
      const participantList = participants
        .map((participant, index) => `${index + 1}. ${safe(participant, 200)}`)
        .join("\n");
      const participantPrompt = `${BASE_INSTRUCTIONS}

حلّل كل مشارك في مجموعة المحادثة بشكل مستقل، مع إبقاء التحليل احتماليًا ومبنياً على الدليل. أعد JSON فقط بهذا الشكل:
{"participants":[{"name":"اسم مطابق للقائمة","communicationStyle":["نمط تواصل ظاهر"],"behavioralTraits":["سمة سلوكية أو لغوية قابلة للملاحظة وليست تشخيصاً"],"openness":"مستوى الانفتاح أو التحفظ مع الدليل","humorAndSeriousness":"طريقة المزاح والجدية والاختلاف مع الدليل","groupInteractions":["طريقة تعامله مع بقية المشاركين"],"comfortSignals":["يميل إلى الارتياح مع اسم: المؤشرات والدليل والثقة"],"tensionSignals":["يظهر توتراً مع اسم: المؤشرات والدليل والثقة"],"attentionSignals":["يعطي اهتماماً أو تفاعلاً أكبر مع اسم: المؤشرات والدليل والثقة"],"possibleIntentions":["قد يشير هذا السلوك إلى... الدليل... مستوى الثقة..."],"evidence":["أدلة موجزة من سياق المحادثة"],"cautions":["حدود هذا الاستنتاج"]}]}

يجب إنشاء بطاقة مستقلة لكل اسم في القائمة، وعدم دمج المشاركين أو اختراع أسماء. استخدم محتوى الرسائل، الشخص الموجّه إليه الكلام، الردود المتبادلة، السياق السابق واللاحق، وتكرار السلوك وتغيره مع الأشخاص المختلفين. لا تستخدم «يحب» أو «يكره» كحقيقة مؤكدة؛ استخدم «يميل إلى الارتياح» أو «توجد مؤشرات على التوتر». لا تدّع معرفة النوايا الحقيقية، واجعل كل استنتاج احتماليًا مع سبب وثقة منخفضة أو متوسطة أو مرتفعة.

المشاركون:
${participantList}

سياق المجموعة:
${sample}`;
      return res.json(parseJson(await generate(participantPrompt, true)));
    }
    const prompt = `${BASE_INSTRUCTIONS}

ابنِ بصمة أسلوبية مؤقتة للشخص المستهدف «${safe(herName, 200)}» من الرسائل أدناه. أعد JSON فقط بالمفاتيح التالية:
{"summary":"خلاصة قصيرة","styleFingerprint":["سمات لغوية قابلة للملاحظة"],"patterns":["أنماط متكررة"],"phrases":["عبارات أو صيغ مميزة"],"signals":["إشارات سياقية"],"cautions":["حدود وتحذيرات"],"situations":["اختلاف الأسلوب حسب الموقف"],"examples":["أمثلة مقتضبة من النص"]}
كل عنصر مختصر ومفيد. لا تخترع معلومات ولا تحول الاحتمال إلى حقيقة.

الرسائل:
${sample}`;
    return res.json(parseJson(await generate(prompt, true)));
  } catch (error) {
    logError(req, error);
    return res.status(500).json({ error: "فشل بناء البصمة باستخدام Gemini." });
  }
});

router.post("/memory-batch", async (req, res) => {
  if (aiUnavailable(res)) return;
  try {
    const { herName, messages = [] } = req.body as { herName?: string; messages?: Message[] };
    if (!Array.isArray(messages) || messages.length === 0) return res.json({ memories: [] });
    const sample = messages
      .map((message, index) => `${index}|${safe(message.date, 40)} ${safe(message.time, 40)}|${safe(message.speaker, 120)}|${safe(message.text, 1000)}`)
      .join("\n")
      .slice(0, MAX_INPUT);
    const prompt = `${BASE_INSTRUCTIONS}

استخرج قرائن أسلوبية مؤقتة من هذه الدفعة من محادثة الشخص المستهدف «${safe(herName, 200)}». اختر فقط المواقف الواضحة التي يمكن الرجوع إليها لاحقاً عند تحليل موقف جديد، ولا تلخص كل الرسائل. ركز على اختلاف أسلوب الشخص حسب السياق. category يجب أن تكون واحدة من: حب/اهتمام، زعل/انزعاج، خلاف، اعتذار/مصالحة، مزاح، غيرة/حساسية، طلب/احتياج، عادي، غير واضح. herMessage مقتطف قصير لا يتجاوز 30 كلمة. confidence بين 0 و100. الحد الأقصى 20 بطاقة. هذه النتائج مؤقتة ولا تعني حفظاً دائماً. أعد JSON فقط بهذا الشكل:
{"memories":[{"title":"عنوان","category":"التصنيف","trigger":"المحفز","context":"السياق","herMessage":"مقتطف","responsePattern":"النمط","keywords":["كلمات"],"evidence":"الدليل","confidence":75}]}
لا تخترع معلومات.

الدفعة:
${sample}`;
    return res.json(parseJson(await generate(prompt, true)));
  } catch (error) {
    logError(req, error);
    return res.status(500).json({ error: "فشل استخراج الذاكرة باستخدام Gemini." });
  }
});

router.post("/analyze", async (req, res) => {
  if (aiUnavailable(res)) return;
  try {
    const { herName, question, profile = {}, memory = [] } = req.body as {
      herName?: string;
      question?: string;
      profile?: Record<string, unknown>;
      memory?: Memory[];
    };
    if (!question?.trim()) return res.status(400).json({ error: "أدخل الموقف أولاً." });
    const memoryText = memory
      .map((item, index) => `#${index + 1} [${safe(item.category, 80)}] ${safe(item.title, 200)}\nالسياق: ${safe(item.context, 1000)}\nرسالة الشخص: ${safe(item.herMessage, 500)}\nالنمط: ${safe(item.responsePattern, 500)}\nالكلمات: ${(item.keywords || []).join(", ")}\nالدليل: ${safe(item.evidence, 500)}`)
      .join("\n\n")
      .slice(0, 140_000);
    const prompt = `${BASE_INSTRUCTIONS}

حلّل الموقف الجديد مع الشخص المستهدف «${safe(herName, 200)}» باستخدام ملف الأسلوب وبطاقات الذاكرة كقرائن، وليس كحقائق عن النية. أعد JSON فقط بهذا الشكل:
{"likelyState":"القراءة الأقرب","confidence":75,"interpretation":"تفسير احتمالي","evidence":["أدلة من النص أو الذاكرة"],"similarPatterns":["أنماط مشابهة"],"alternatives":["احتمالات أخرى"],"suggestedResponses":["رد طبيعي ومحترم","رد طبيعي بديل"],"whatNotToDo":["أشياء يفضل تجنبها"],"uncertainty":"ما الذي لا يمكن الجزم به"}
إذا كان النص غير كافٍ، قل ذلك وخفّض الثقة. اقترح ردوداً طبيعية ومحترمة وغير متلاعبة.

ملف الأسلوب:
${JSON.stringify(profile).slice(0, 50_000)}

بطاقات الذاكرة:
${memoryText}

الموقف الجديد:
${safe(question, 70_000)}`;
    return res.json(parseJson(await generate(prompt, true)));
  } catch (error) {
    logError(req, error);
    return res.status(500).json({ error: "فشل تحليل الموقف باستخدام Gemini." });
  }
});

router.post("/chat", async (req, res) => {
  if (aiUnavailable(res)) return;
  try {
    const { herName, profile = {}, memory = [], chat = [], message } = req.body as {
      herName?: string;
      profile?: Record<string, unknown>;
      memory?: Memory[];
      chat?: { role?: string; content?: string }[];
      message?: string;
    };
    if (!message?.trim()) return res.status(400).json({ error: "اكتب سؤالك." });
    const memoryText = memory
      .map((item, index) => `#${index + 1} [${safe(item.category, 80)}] ${safe(item.title, 200)}: ${safe(item.context, 1000)} | رسالة الشخص: ${safe(item.herMessage, 500)} | النمط: ${safe(item.responsePattern, 500)}`)
      .join("\n")
      .slice(0, 90_000);
    const conversation = chat
      .map((item) => `${item.role === "user" ? "المستخدم" : "المساعد"}: ${safe(item.content, 3000)}`)
      .join("\n")
      .slice(-30_000);
    const prompt = `${BASE_INSTRUCTIONS}

أنت المساعد داخل «مرآة الأسلوب». أجب بالعربية العراقية الطبيعية عندما تناسب. اعتمد على ملف الأسلوب والذكريات المسترجعة وسياق الدردشة. إذا سأل المستخدم «شنو تقصد؟» أعطه القراءة الأقرب ثم الدليل والبدائل. إذا سأل «شنو أرد؟» اقترح ردوداً طبيعية ومحترمة وغير متلاعبة. لا تقل إنك تعرف ما في داخلها. لا تحوّل الذاكرة إلى تشخيص أو حكم.

الشخص المستهدف: ${safe(herName, 200)}
ملف الأسلوب: ${JSON.stringify(profile).slice(0, 50_000)}
الذكريات المسترجعة:
${memoryText}
سياق الدردشة:
${conversation}
سؤال المستخدم: ${safe(message, 30_000)}`;
    return res.json({ answer: await generate(prompt) });
  } catch (error) {
    logError(req, error);
    return res.status(500).json({ error: "فشل الرد باستخدام Gemini." });
  }
});

export default router;