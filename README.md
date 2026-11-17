# Postador de clipes (grátis)

Fluxo: **equipe solta o clipe na pasta do Google Drive → GitHub Actions (a cada 15 min) → Gemini escreve as legendas → Upload-Post coloca na fila (7h–21h, 1 por hora, todo dia) → TikTok + Instagram + YouTube.**

Clipes postados ficam marcados no Drive (propriedade invisível), então nunca postam duas vezes. Se a equipe soltar mais de 15 num dia, o excedente vai para os horários do dia seguinte.

## Configuração (uma vez só, ~20 min)

### 1. Pasta no Google Drive
1. Crie uma pasta, ex.: `Clipes para postar`, e compartilhe com a equipe.
2. Copie o ID da pasta (o trecho da URL depois de `/folders/`).

### 2. Conta de serviço do Google (para o robô ler o Drive)
1. Acesse https://console.cloud.google.com → crie um projeto (ex.: `postador-clipes`).
2. Em **APIs e serviços → Biblioteca**, ative a **Google Drive API**.
3. Em **IAM e administrador → Contas de serviço**, crie uma conta → aba **Chaves** → **Adicionar chave → JSON**. Baixa um arquivo `.json`.
4. Copie o e-mail da conta de serviço (algo como `xxx@postador-clipes.iam.gserviceaccount.com`) e **compartilhe a pasta do Drive com ele como Editor**.

### 3. Chave do Gemini (grátis)
https://aistudio.google.com/apikey → **Criar chave de API**.

### 4. Chave do Upload-Post
No Upload-Post → **Chaves de API** → gerar chave.

### 5. GitHub
1. Crie um repositório **privado** e suba estes arquivos (incluindo a pasta `.github`).
2. Em **Settings → Secrets and variables → Actions → New repository secret**, crie:

| Nome | Valor |
|---|---|
| `DRIVE_FOLDER_ID` | ID da pasta do passo 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | o conteúdo inteiro do arquivo `.json` do passo 2 |
| `GEMINI_API_KEY` | chave do passo 3 |
| `UPLOADPOST_API_KEY` | chave do passo 4 |

### 6. Testar
1. Coloque 1 clipe na pasta.
2. No GitHub → **Actions → Postar clipes do Drive → Run workflow**, marque **dry_run** → veja no log as legendas geradas (nada é postado).
3. Rode de novo sem dry_run → o clipe aparece no **Calendário** do Upload-Post no próximo horário livre.

Depois disso roda sozinho a cada 15 min, todos os dias.

## Ajustes
- **Estilo das legendas:** edite `prompt.md` (tom, CTA, hashtags fixas).
- **Modelo do Gemini:** `GEMINI_MODEL` no `.github/workflows/postar.yml`.
- **Horários:** mudam no Upload-Post → Configurações da fila (não no código).

## Custos
Tudo no plano grátis: GitHub Actions (2.000 min/mês em repo privado; usa ~300–500), Gemini (free tier), Google Drive. Só o Upload-Post Basic é pago.
