// Postador de clipes: Google Drive -> Gemini (legendas) -> Upload-Post (fila TikTok/Instagram/YouTube)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import { GoogleGenAI, createPartFromUri, Type } from '@google/genai';

// ---------- Config (via variáveis de ambiente / GitHub Secrets) ----------
const env = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
};

const DRIVE_FOLDER_ID = env('DRIVE_FOLDER_ID');
const GOOGLE_SERVICE_ACCOUNT_JSON = env('GOOGLE_SERVICE_ACCOUNT_JSON');
const GEMINI_API_KEY = env('GEMINI_API_KEY');
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-3.8-flash');
const UPLOADPOST_API_KEY = env('UPLOADPOST_API_KEY');
const UPLOADPOST_PROFILE = env('UPLOADPOST_PROFILE', 'default');
const PLATFORMS = env('PLATFORMS', 'tiktok,instagram,youtube').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_POR_EXECUCAO = Number(env('MAX_POR_EXECUCAO', '15'));
const DRY_RUN = process.env.DRY_RUN === 'true';

const MARCA = 'uploadpost_status'; // appProperty gravada no arquivo do Drive depois de enviar

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Google Drive ----------
function driveClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function listarClipesNovos(drive) {
  const arquivos = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and mimeType contains 'video/' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, appProperties)',
      orderBy: 'createdTime,name',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    arquivos.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return arquivos.filter((f) => !f.appProperties?.[MARCA]);
}

async function baixar(drive, arquivo, destino) {
  const res = await drive.files.get(
    { fileId: arquivo.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  await pipeline(res.data, fs.createWriteStream(destino));
}

async function marcar(drive, arquivo, valor) {
  await drive.files.update({
    fileId: arquivo.id,
    requestBody: { appProperties: { [MARCA]: valor } },
    supportsAllDrives: true,
  });
}

// ---------- Gemini (legendas) ----------
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const PROMPT = fs.readFileSync(new URL('../prompt.md', import.meta.url), 'utf8');

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    youtube_title: { type: Type.STRING },
    youtube_description: { type: Type.STRING },
    youtube_tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    instagram_caption: { type: Type.STRING },
    tiktok_caption: { type: Type.STRING },
  },
  required: ['youtube_title', 'youtube_description', 'youtube_tags', 'instagram_caption', 'tiktok_caption'],
};

async function gerarLegendas(caminho, mimeType, nomeArquivo) {
  let arquivo = await ai.files.upload({ file: caminho, config: { mimeType } });
  // espera o Gemini terminar de processar o vídeo
  for (let i = 0; i < 60 && arquivo.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    arquivo = await ai.files.get({ name: arquivo.name });
  }
  if (arquivo.state !== 'ACTIVE') throw new Error(`Gemini não processou o vídeo (estado: ${arquivo.state})`);

  try {
    // tenta cada modelo da lista (GEMINI_MODEL separado por vírgula), com novas tentativas se o Gemini estiver sobrecarregado
    const modelos = GEMINI_MODEL.split(',').map((m) => m.trim()).filter(Boolean);
    let res, ultimoErro;
    for (const modelo of modelos) {
      for (let tentativa = 1; tentativa <= 4 && !res; tentativa++) {
        try {
          res = await ai.models.generateContent({
            model: modelo,
            contents: [
              createPartFromUri(arquivo.uri, arquivo.mimeType),
              `${PROMPT}\n\nNome do arquivo (pode dar contexto): ${nomeArquivo}\nResponda só com o JSON.`,
            ],
            config: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.8 },
          });
          log(`  legendas geradas com ${modelo}`);
        } catch (e) {
          ultimoErro = e;
          const temporario = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(String(e?.message ?? e));
          log(`  ${modelo} falhou (tentativa ${tentativa}): ${String(e?.message ?? e).slice(0, 150)}`);
          if (!temporario) break; // erro definitivo: pula para o próximo modelo
          await new Promise((r) => setTimeout(r, 15000 * tentativa));
        }
      }
      if (res) break;
    }
    if (!res) throw ultimoErro;
    const l = JSON.parse(res.text);
    // limites das redes
    l.youtube_title = cortar(l.youtube_title, 100);
    l.tiktok_caption = cortar(l.tiktok_caption, 2200);
    l.instagram_caption = cortar(l.instagram_caption, 2200);
    l.youtube_description = cortar(l.youtube_description, 5000);
    return l;
  } finally {
    ai.files.delete({ name: arquivo.name }).catch(() => {});
  }
}

const cortar = (s, max) => {
  s = String(s ?? '').replace(/\s+\n/g, '\n').trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
};

// ---------- Upload-Post ----------
async function colocarNaFila(caminho, arquivo, l) {
  const form = new FormData();
  form.append('user', UPLOADPOST_PROFILE);
  for (const p of PLATFORMS) form.append('platform[]', p);
  const blob = await fs.openAsBlob(caminho, { type: arquivo.mimeType || 'video/mp4' });
  form.append('video', blob, arquivo.name);

  form.append('title', l.youtube_title); // obrigatório p/ YouTube; fallback geral
  form.append('add_to_queue', 'true'); // vai para o próximo horário livre da fila
  form.append('async_upload', 'true');
  form.append('external_id', arquivo.id);

  // TikTok
  form.append('tiktok_title', l.tiktok_caption);
  form.append('privacy_level', 'PUBLIC_TO_EVERYONE');
  // Instagram
  form.append('instagram_title', l.instagram_caption);
  form.append('media_type', 'REELS');
  form.append('share_to_feed', 'true');
  // YouTube
  form.append('youtube_title', l.youtube_title);
  form.append('youtube_description', l.youtube_description);
  form.append('privacyStatus', 'public');
  for (const t of l.youtube_tags ?? []) form.append('tags[]', t);

  const res = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Apikey ${UPLOADPOST_API_KEY}`,
      'Idempotency-Key': `drive-${arquivo.id}`, // evita post duplicado se rodar de novo
    },
    body: form,
  });
  const corpo = await res.text();
  let json;
  try { json = JSON.parse(corpo); } catch { json = { raw: corpo }; }
  if (!res.ok || json.success === false) {
    throw new Error(`Upload-Post respondeu ${res.status}: ${corpo.slice(0, 500)}`);
  }
  return json;
}

// ---------- Execução ----------
async function main() {
  const drive = driveClient();
  const novos = (await listarClipesNovos(drive)).slice(0, MAX_POR_EXECUCAO);
  log(`Clipes novos encontrados: ${novos.length}`);
  if (!novos.length) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipes-'));
  let falhas = 0;

  for (const arquivo of novos) {
    const caminho = path.join(tmp, arquivo.id + path.extname(arquivo.name || '.mp4'));
    try {
      log(`▶ ${arquivo.name}`);
      await baixar(drive, arquivo, caminho);
      const l = await gerarLegendas(caminho, arquivo.mimeType || 'video/mp4', arquivo.name);
      log('  legendas:', JSON.stringify(l));
      if (DRY_RUN) { log('  DRY_RUN ativo: não enviado'); continue; }
      const r = await colocarNaFila(caminho, arquivo, l);
      log('  na fila:', JSON.stringify(r));
      await marcar(drive, arquivo, `enviado ${new Date().toISOString()}`);
    } catch (e) {
      falhas++;
      console.error(`  ✖ erro em ${arquivo.name}:`, e.message);
    } finally {
      fs.rmSync(caminho, { force: true });
    }
  }
  if (falhas) {
    console.error(`${falhas} clipe(s) falharam; serão tentados de novo na próxima execução.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
