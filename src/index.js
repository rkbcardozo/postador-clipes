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
const PLATFORMS = env('PLATFORMS', 'tiktok,instagram,youtube')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_POR_EXECUCAO = Number(env('MAX_POR_EXECUCAO', '15'));
const DRY_RUN = process.env.DRY_RUN === 'true';

const MARCA_STATUS = 'uploadpost_status';
const MARCA_ENVIADAS = 'uploadpost_enviadas';

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

function redesJaEnviadas(arquivo) {
  const raw = arquivo.appProperties?.[MARCA_ENVIADAS] || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function redesFaltantes(arquivo) {
  const feitas = new Set(redesJaEnviadas(arquivo));
  return PLATFORMS.filter((p) => !feitas.has(p));
}

async function listarClipesPendentes(drive) {
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

  return arquivos.filter((f) => {
    const faltantes = redesFaltantes(f);
    if (!faltantes.length) return false;
    if (!f.appProperties?.[MARCA_ENVIADAS] && f.appProperties?.[MARCA_STATUS]) return false;
    return true;
  });
}

async function baixar(drive, arquivo, destino) {
  const res = await drive.files.get(
    { fileId: arquivo.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  );
  await pipeline(res.data, fs.createWriteStream(destino));
}

async function salvarProgresso(drive, arquivo, plataformasSucesso, pendentesLimite) {
  const atual = new Set(redesJaEnviadas(arquivo));
  for (const p of plataformasSucesso) atual.add(p);

  const listaFeitas = [...atual].filter((p) => PLATFORMS.includes(p));
  const restante = PLATFORMS.filter((p) => !atual.has(p));

  let status;
  if (!restante.length) {
    status = `enviado ${new Date().toISOString()}`;
  } else if (pendentesLimite.length) {
    status = `aguardando_limite(${pendentesLimite.join(',')}) ${new Date().toISOString()}`;
  } else {
    status = `parcial(${restante.join(',')}) ${new Date().toISOString()}`;
  }

  await drive.files.update({
    fileId: arquivo.id,
    requestBody: {
      appProperties: {
        [MARCA_ENVIADAS]: listaFeitas.join(','),
        [MARCA_STATUS]: status,
      },
    },
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
  for (let i = 0; i < 60 && arquivo.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    arquivo = await ai.files.get({ name: arquivo.name });
  }
  if (arquivo.state !== 'ACTIVE') {
    throw new Error(`Gemini não processou o vídeo (estado: ${arquivo.state})`);
  }

  try {
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
            config: {
              responseMimeType: 'application/json',
              responseSchema: SCHEMA,
              temperature: 0.8,
            },
          });
          log(`  legendas geradas com ${modelo}`);
        } catch (e) {
          ultimoErro = e;
          const temporario = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(
            String(e?.message ?? e),
          );
          log(`  ${modelo} falhou (tentativa ${tentativa}): ${String(e?.message ?? e).slice(0, 150)}`);
          if (!temporario) break;
          await new Promise((r) => setTimeout(r, 15000 * tentativa));
        }
      }
      if (res) break;
    }
    if (!res) throw ultimoErro;

    const l = JSON.parse(res.text);
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
function ehLimiteDePlataforma(err) {
  return /\b429\b|daily posting cap|used_last_24h|Consider scheduling for later/i.test(
    String(err?.message ?? err),
  );
}

async function enviarParaPlataformas(caminho, arquivo, l, plataformasAlvo) {
  const form = new FormData();
  form.append('user', UPLOADPOST_PROFILE);
  for (const p of plataformasAlvo) form.append('platform[]', p);

  const blob = await fs.openAsBlob(caminho, { type: arquivo.mimeType || 'video/mp4' });
  form.append('video', blob, arquivo.name);
  form.append('title', l.youtube_title);
  form.append('add_to_queue', 'true');
  form.append('async_upload', 'true');
  form.append('external_id', arquivo.id);

  if (plataformasAlvo.includes('tiktok')) {
    form.append('tiktok_title', l.tiktok_caption);
    form.append('privacy_level', 'PUBLIC_TO_EVERYONE');
  }
  if (plataformasAlvo.includes('instagram')) {
    form.append('instagram_title', l.instagram_caption);
    form.append('media_type', 'REELS');
    form.append('share_to_feed', 'true');
  }
  if (plataformasAlvo.includes('youtube')) {
    form.append('youtube_title', l.youtube_title);
    form.append('youtube_description', l.youtube_description);
    form.append('privacyStatus', 'public');
    for (const t of l.youtube_tags ?? []) form.append('tags[]', t);
  }

  const chaveSufixo = [...plataformasAlvo].sort().join('-');
  const res = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Apikey ${UPLOADPOST_API_KEY}`,
      'Idempotency-Key': `drive-${arquivo.id}-${chaveSufixo}`,
    },
    body: form,
  });

  const corpo = await res.text();
  let json;
  try {
    json = JSON.parse(corpo);
  } catch {
    json = { raw: corpo };
  }
  if (!res.ok || json.success === false) {
    throw new Error(`Upload-Post respondeu ${res.status}: ${corpo.slice(0, 500)}`);
  }
  return json;
}

// ---------- Execução ----------
async function main() {
  const drive = driveClient();
  const pendentes = (await listarClipesPendentes(drive)).slice(0, MAX_POR_EXECUCAO);
  log(`Clipes pendentes encontrados: ${pendentes.length}`);
  if (!pendentes.length) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipes-'));
  let falhasReais = 0;

  for (const arquivo of pendentes) {
    const caminho = path.join(tmp, arquivo.id + path.extname(arquivo.name || '.mp4'));
    const alvos = redesFaltantes(arquivo);
    const outrasRedes = alvos.filter((p) => p !== 'tiktok');
    const temTiktok = alvos.includes('tiktok');

    const enviadasNestaRodada = [];
    const pendentesLimite = [];

    try {
      log(`▶ ${arquivo.name} (alvos: ${alvos.join(', ')})`);
      await baixar(drive, arquivo, caminho);
      const l = await gerarLegendas(caminho, arquivo.mimeType || 'video/mp4', arquivo.name);
      log('  legendas:', JSON.stringify(l));

      if (DRY_RUN) {
        log('  DRY_RUN ativo: não enviado');
        continue;
      }

      // 1) Tenta mandar TODAS as redes juntas: entram no MESMO horário da fila
      let enviouJunto = false;
      if (temTiktok && outrasRedes.length) {
        try {
          const rTodas = await enviarParaPlataformas(caminho, arquivo, l, alvos);
          log(`  na fila juntos (${alvos.join(',')}):`, JSON.stringify(rTodas));
          enviadasNestaRodada.push(...alvos);
          enviouJunto = true;
        } catch (e) {
          if (ehLimiteDePlataforma(e)) {
            log('  ⏳ limite em alguma rede: tentando separado...');
          } else {
            falhasReais++;
            console.error(`  ✖ erro em ${arquivo.name} (${alvos.join(',')}):`, e.message);
            continue;
          }
        }
      }

      // 2) Só se não deu junto (limite do TikTok), manda separado
      if (!enviouJunto && outrasRedes.length) {
        try {
          const rOutras = await enviarParaPlataformas(caminho, arquivo, l, outrasRedes);
          log(`  na fila (${outrasRedes.join(',')}):`, JSON.stringify(rOutras));
          enviadasNestaRodada.push(...outrasRedes);
        } catch (e) {
          if (ehLimiteDePlataforma(e)) {
            pendentesLimite.push(...outrasRedes);
            log(`  ⏳ limite atingido em (${outrasRedes.join(',')}): fica para depois.`);
          } else {
            falhasReais++;
            console.error(`  ✖ erro em ${arquivo.name} (${outrasRedes.join(',')}):`, e.message);
          }
        }
      }

      if (!enviouJunto && temTiktok) {
        try {
          const rTikTok = await enviarParaPlataformas(caminho, arquivo, l, ['tiktok']);
          log('  na fila (tiktok):', JSON.stringify(rTikTok));
          enviadasNestaRodada.push('tiktok');
        } catch (e) {
          if (ehLimiteDePlataforma(e)) {
            pendentesLimite.push('tiktok');
            log(`  ⏳ tiktok no limite de 24h em ${arquivo.name}; fica pendente para depois.`);
          } else {
            falhasReais++;
            console.error(`  ✖ erro em ${arquivo.name} (tiktok):`, e.message);
          }
        }
      }

      if (enviadasNestaRodada.length || pendentesLimite.length) {
        await salvarProgresso(drive, arquivo, enviadasNestaRodada, pendentesLimite);
      }
    } catch (e) {
      falhasReais++;
      console.error(`  ✖ erro em ${arquivo.name}:`, e.message);
    } finally {
      fs.rmSync(caminho, { force: true });
    }
  }

  if (falhasReais) {
    console.error(`${falhasReais} falha(s) real(is) ocorrida(s).`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
