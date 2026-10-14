# Papo Wormhole — Especificação técnica

Bot bridge entre **Papo** (chat self-hosted, Go + Echo + PostgreSQL + WebSocket) e **Discord**,
com forward bidirecional de mensagens, attachments, embeds/link previews, reações, edições e
deleções, preservando identidade visual do autor em ambos os lados.

> Fontes de referência: `papo-backend/openapi.yml` (API REST + eventos WS), documentação de
> embeds/limites do Discord. Valores de limite conferidos em out/2026.

---

## 1. Funcionalidade

1. **Forward bidirecional** de mensagens entre canais Papo ↔ canais Discord linkados
   (`/link-channel`), incluindo attachments e embeds.
2. **Identidade do autor**: no Discord a mensagem chega como *rich embed* com avatar do usuário
   do Papo, `nickname > username`, data e conteúdo. No Papo, a mensagem chega com embed próprio
   do Papo (mesma estrutura: autor, avatar, data, origem).
3. **Conversão de emojis**: verifica se o emoji existe nos dois servidores e converte
   Papo → Discord e Discord → Papo; quando não existe, importa/clona sob demanda.
4. **Link previews preservados** nos dois sentidos.
5. **Buffer persistente (SQLite)**: mensagem que falha em um dos lados fica em fila com retry
   exponencial, sem perder ordem e sem duplicar após restart.

---

## 2. Restrições que moldam o design

| Fato | Consequência no design |
| --- | --- |
| Papo tem **no máximo 1 servidor** (`POST /server` → 409 se já existe) | `/link-server` é 1:1 e quase sempre redundante; manter por conveniência de config, mas o bridge é chaveado por **canal** |
| Papo não tem contas "bot": o bot é um **usuário comum** autenticado por cookie JWT (`Auth`) | Toda mensagem bridge no Papo é autoria do usuário-bot → a identidade real só pode ser transportada em **embed** (autor + avatar) |
| Autenticação Papo é cookie HttpOnly; JWT expira em 24h, renovável por até 30 dias em `POST /auth/refresh` | Loop de refresh agendado (ex.: a cada 12h) + re-login em 401 + reconexão WebSocket com o novo cookie |
| Discord não permite username/avatar arbitrários por mensagem via bot comum | Autoria no Discord é feita por **embed author** (modo A) ou por **webhook** por canal (modo B, opcional) |
| Discord: `content` 2000 chars, 10 embeds/mensagem, **6000 chars somando todos os embeds**, 10 arquivos/mensagem, arquivo ≤ 20 MB (free) | Chunking determinístico + pipeline de compressão/partição de arquivos |
| Papo: `content` **8192 chars**, 10 attachments/mensagem (≤ 100 MB, nome ≤ 128), 10 embeds/mensagem, título 256, descrição 4192, 25 fields, field name 256 / value 1024, autor 256, footer 2048, **6000 chars somando todos os embeds**, URL 2048 | Orçamento de embed idêntico ao Discord → chunking único com `min(lado destino)`; o corpo vai em `content` (8192), não em embed |
| Rate limits do Papo não documentados (só `authRateLimit` no middleware de rotas) | Throttle client-side conservador por canal + backoff em 429/5xx |

---

## 3. Arquitetura

```
                ┌──────────────────────────────────────────────┐
                │                 BRIDGE CORE                  │
                │  (pipeline normalizado, single writer por    │
                │   canal-link, ordem FIFO)                    │
                └──────────────────────────────────────────────┘
                   ▲                              │
        ┌──────────┴──────────┐        ┌─────────┴──────────────┐
        │  PAPO ADAPTER       │        │  DISCORD ADAPTER       │
        │  - REST client      │        │  - gateway client      │
        │  - WS client (/ws)  │        │  - REST client         │
        │  - auth/refresh     │        │  - webhook pool (modo B)│
        └──────────┬──────────┘        └─────────┬──────────────┘
                   │        ┌────────────┐       │
                   └────────┤  STORE     ├───────┘
                            │  SQLite    │
                            └─────┬──────┘
              ┌───────────────────┼──────────────────────┐
              │  MAPPING: links,  │  MEDIA CACHE (blobs, │
              │  users, emojis,   │  avatares, arquivos) │
              │  message_map      │                      │
              └───────────────────┴──────────────────────┘
                        ▲
              ┌─────────┴─────────┐        ┌──────────────────┐
              │  OUTBOX WORKER    │        │  MEDIA SERVER    │
              │  retry/backoff    │        │  (HTTPS, opcional│
              │  dead-letter      │        │   p/ avatares)   │
              └───────────────────┘        └──────────────────┘
```

Componentes:

- **Papo Adapter**: login (`/auth/login`), keep-alive (`heartbeat`), refresh de sessão, conexão
  `ws://…/ws`, cursor de replay por canal (`GET /channels/{id}/messages?since=&last_id=&order=asc`).
- **Discord Adapter**: gateway (intents), REST, pool de webhooks por canal (modo B), tratamento de
  429 (`Retry-After`, `X-RateLimit-Reset-After`, bucket por rota).
- **Translator**: markdown ↔ markdown, menções, emojis, embeds, attachments, reações.
- **Store**: SQLite (WAL) — links, mapeamentos, `message_map`, outbox, cache de mídia, presença.
- **Outbox worker**: um worker serializado **por canal-link** (garante ordem), concorrência entre
  links diferentes.
- **Media server (opcional)**: expõe `GET /media/{sha256}.{ext}` para dar URL pública a avatar
  Papo (Discord exige `author.icon_url` como URL). Sem `WORMHOLE_MEDIA_BASE_URL` o avatar vai
  como **anexo da mensagem** e o embed referencia `attachment://avatar-<sha256>.<ext>` — o Discord
  aceita referência local em `author.icon_url` e não mostra o arquivo separado.

---

## 4. Identidade e mapeamento de autores

- **Modo A (padrão)** — bot comum no Discord, autoria via embed:
  `author.name = nickname ?? username` (Papo), `author.icon_url = <media server>/media/<sha>.png`
  (ou `attachment://avatar-<sha>.<ext>` quando não há media server público), `author.url` opcional.
- **Modo B (opcional, por canal-link)** — webhook por canal: `username`/`avatar_url` do webhook
  por mensagem → autoria visual perfeita, custo: permissão `Manage Webhooks`, limite de webhooks
  por canal e rate limit próprio.
- **Papo (ambos os modos)**: embed custom (`EmbedInput`) com
  `author.name = nickname ?? username` do usuário Discord e `author.icon_url = <avatar Discord>`
  (HTTPS). O backend do Papo baixa e re-serva o avatar em `embeds.author_media`; o card desenha
  esse ícone no selo da linha de topo e `site_name` (aqui, o nome do autor) ao lado. Avatar na
  `thumbnail` **não**: o `EmbedCard` desenha a thumbnail como imagem grande do card (largura total).
- `/link-user` é **opcional**: sem link, usa modo espelho (nome/avatar no embed). Com link,
  habilita: menções traduzidas, `/online` cruzado, reações atribuídas, e futura sincronia de papéis.

---

## 5. Normalização de conteúdo

Regra geral: **CommonMark é pass-through**; só reescrever sintaxe específica de plataforma.

| Recurso | Discord | Papo | Regra de tradução |
| --- | --- | --- | --- |
| negrito/itálico/riscado/código/bloco/citação/listas | markdown | markdown | pass-through |
| spoiler `||x||` | suporta | confirmar | pass-through; se Papo não renderiza, converter para `**spoiler:**` |
| link `[t](u)` | suporta | suporta | pass-through |
| menção de usuário | `<@id>` | `@mention(<@uuid>)` | **por padrão não propagar menção real**: renderizar `@nickname` em texto (evita ping em cascata e loops). Habilitável por canal-link (`/bridge-config … mentions:true`, que é lido pelo translator junto com `WORMHOLE_PROPAGATE_MENTIONS`). Propagada, a menção vira chip clicável no card dos dois lados — embed não gera notificação nem no Discord nem no Papo (o trigger de notificação do Papo lê só `content`) |
| menção de canal | `<#id>` | sem sintaxe | substituir por `#nome` |
| menção de role | `<@&id>` | sem sintaxe | substituir por nome da role |
| `@everyone` / `@here` | ping real | exige `everyone_message` | neutralizado para `@\u200beveryone` (zero-width): a conta do bridge pode ter `everyone_message` e o texto atravessaria como ping em massa |
| timestamp relativo `<t:epoch:R>` | suporta | não suporta | expandir para data/hora absoluta no destino |
| emoji unicode | unicode | unicode | pass-through |
| emoji custom | `<:name:id>` / `<a:name:id>` | confirmar sintaxe inline | ver §6 |
| sticker / poll / botão / thread | componentes | não existem | fallback textual (ex. `[sticker: nome]`, `[enquete: …]`) |

**Rótulo de menção** (o caminho padrão, sem `propagate_mentions`): o id do mencionado é resolvido
pelo cache de usuários do lado de destino — `users_discord` (nome global e apelido do guild, que o
payload do Discord traz em `message.mentions`; o que faltar é buscado uma vez por `users.fetch`) e
`users_papo` (batch `POST /users/user_summary_batch` antes de traduzir). Mencionado normalmente não
está no cache porque nunca autorou uma mensagem ponte, e snowflake/uuid não diz nada a quem lê: sem
rótulo o bridge assina `@usuário`, nunca o id cru.

**Anti-loop (obrigatório)**: descartar na entrada qualquer mensagem cujo autor seja o usuário-bot
do Papo ou o próprio bot/webhook do Discord; além disso `message_map` é único por
`(origem, id_da_mensagem_origem)` — uma mensagem já bridgeada nunca é re-bridgeada.

**Anti-eco em reações**: os filtros de autor só cobrem *mensagens*. No Discord dá para filtrar a
reação pelo `user` do evento; no Papo o `react_update` traz apenas `count`, sem quem reagiu. Por
isso toda reação que aplicamos no Papo é registrada em `self_reactions`, e um `react_update` que
casa com uma linha recente (120 s) é tratado como eco: a contagem é atualizada, mas a reação não
volta ao Discord (o que inflaria a contagem visível com a reação do bot).
**A marca é escrita antes da chamada**: o backend do Papo transmite o `react_update` antes de
devolver o `POST` da reação, então o eco chega com a nossa chamada ainda em voo — marcar depois de
`addReaction` fazia o eco escapar e a reação voltava ao Discord duplicada. Se a chamada falha, a
marca é removida (`clearSelfReaction`) para não esconder uma reação legítima seguinte.

**Mutação só escreve na cópia do bot** (`message_map.direction`): edição, deleção e refresh de
rodapé só podem tocar a mensagem que o próprio bridge criou. `papo_to_discord` → a cópia editável
está no Discord; `discord_to_papo` → a cópia editável está no Papo. Os eventos que chegam do outro
lado de uma cópia nossa são eco do que nós mesmos fizemos e são descartados na entrada
(`allCopiesHere`), sem job. Reação é a exceção: reagir em mensagem de terceiros é permitido, então
a reação nativa vai para a mensagem original — só o rodapé dela fica intocado (Discord 50005 e
Papo 403 recusam edição de terceiros, e cada lado já mostra suas próprias reações).

**Anti-ping**: no Discord enviar sempre `allowed_mentions: { parse: [] }`.

---

## 6. Emojis

Modelo: **emoji é identificado por nome normalizado** (lowercase, sem `:`), pois é o único campo
comum entre as plataformas.

Tabela `emoji_map(name, papo_emoji_id, discord_emoji_id, discord_animated, image_sha)`.

Pipeline Discord → Papo:
1. Extrair `<:name:id>` / `<a:name:id>` do conteúdo.
2. Cache em `emoji_map`; senão, `GET /emojis?since=&last_id=` (25/página) no Papo e procurar por
   `name`.
3. Se ausente e `emoji.auto_import = true`: `GET https://cdn.discordapp.com/emojis/{id}.png`
   (ou `.gif`), validar ≤ 256 KB / ≤ 512 px (limite do Papo; redimensionar com sharp se
   estourar), `POST /emojis {name, image_blob(base64), format}`.
   - 409 (nome existe) → re-ler a lista e reaproveitar.
   - Limite de 500 emojis no Papo → logar e cair para fallback textual `:name:`.
4. Renderizar no conteúdo Papo (sintaxe a confirmar — §22 Q1); fallback `:name:`.

Pipeline Papo → Discord:
1. Resolver `emoji_id` → `name` (+ imagem) via cache/`GET /emojis`.
2. Procurar emoji de mesmo nome no guild (`client.guilds.cache.emojis`).
3. Se existir → `<:name:id>` (ou `<a:name:id>` se animado).
4. Se não existir no guild → procurar **emoji da aplicação** (`client.application.emojis`,
   `ApplicationEmojiManager` do discord.js), carregado na conexão por
   `GET /applications/{id}/emojis`. Achou → `<:name:id>`.
5. Se tampoco existir → **criar um emoji da aplicação** com a imagem do emoji no Papo
   (`POST /applications/{id}/emojis`): 2000 por app, imagem ≤ 256 KiB, não ocupa slot do
   guild e não exige permissão nenhuma no servidor. Renderiza no cartão do bot e na cópia
   enviada pelo webhook do bridge (o token completo `<:name:id>` é obrigatório — `:name:`
   sozinho não resolve), e o Discord aceita reação do bot com emoji que o próprio app criou.
6. Se a criação falhar (limite do app, imagem rejeitada, nome de 1 caractere que o Discord
   não aceita) → `:name:`. A falha entra em cooldown: a fila não insiste na rota de criação,
   que o Discord limita duramente.

Reações: `react_update` (Papo) ↔ `messageReactionAdd/Remove` (Discord), com o mesmo `emoji_map`.
O Papo tem 20 tipos de reação por mensagem (o Discord não tem limite duro) → o resumo mostra no
máximo 8 emojis.

**Comportamento implementado (v1)**

- A reação é reproduzida como **reação nativa na mensagem de destino** — nunca como texto no corpo.
- Além disso, o **`description` do embed carrega o resumo de contagem** numa linha final:
  `texto da mensagem` + `\n\n↳ 👍 3 · <:papu:1234> 1`. Isso existe porque a identidade de quem
  reagiu não sobrevive à travessia (o bridge só tem uma conta em cada lado), então a contagem é o
  que se preserva. `GET /channels/{cid}/messages/{mid}/reactions` devolve `user_id` por reação,
  caso uma versão futura queira nomes.
- O resumo mora no `description`, **não no rodapé**: footer de embed não renderiza emoji custom em
  nenhum dos lados (no Discord o `<:nome:id>` aparece cru; no Papo `EmbedCard` desenha
  `footer.text` como texto puro). Só o `description` passa pelo renderizador de emoji nos dois
  lados — no Discord como `<:nome:id>`, no Papo como shortcode `:nome:`. O rodapé fica com
  data/origem (`🕒 09/10/2026 14:22 · Papo 1/2`).
- Contagem vem **absoluta** nos dois lados (`react_update.count`; `MessageReaction.count` do Discord) e
  fica em `reaction_counts (link_id, source, source_message_id, emoji)`. `count = 0` remove o emoji do resumo.
  A forma canônica do banco é unicode literal ou `:nome:`; o dialeto do destino é aplicado na renderização.
- Emoji custom do Papo sem homônimo no guild: o bridge usa o **emoji da aplicação** com o mesmo
  nome, ou cria um (`ApplicationEmojiManager`) a partir da imagem do emoji no Papo. Só cai para
  `:nome:` cru (sem reação nativa — no Discord, `react(":nome:")` é 400) quando não há imagem
  para subir ou o Discord recusa a criação.
- Emoji do guild que o Discord recusa (10014 `Unknown Emoji` — apagado por moderação ou marcado
  `available: false`, flag que o discord.js não expõe no cache do gateway): a lista de indisponíveis é
  lida de `GET /guilds/{id}/emojis` na conexão e re-carregada quando um 10014 aparece; sem equivalente
  utilizável o job **não falha**, a reação fica só no resumo.
- A conversão do emoji acontece na **execução** do job (§10.1): guild ainda sem emojis no cache faz o
  job voltar para a fila, em vez de decidir "não existe equivalente" com o cache frio.
- Remoção é propagada nos dois sentidos: `count = 0` no Papo → `MessageReaction#remove()` no Discord
  (remove a reação da conta do bot); `messageReactionRemove` → `DELETE .../reactions`.
- O resumo é re-renderizado por um job `edit` com `footerOnly` e dedupe por bucket de 3 s, para
  rajadas de reação não virarem dezenas de edições. O embed re-renderizado vem do snapshot guardado
  em `message_map.rendered / bridge_embed / footer_base`, e o destino é a **cópia criada pelo bot**
  (definido por `map.direction`) — nunca a mensagem original do outro lado.

---

## 7. Attachments e mídia

Download Papo: `GET /attachments/{file_id}` (suporta `Range`); thumbnail em
`GET /attachments/{file_id}/thumbnail` (WebP/GIF).
Download Discord: `message.attachments[].url` (CDN HTTPS).

Decisões por tamanho (limite efetivo do Discord free = **20 MB** por arquivo; Nitro Basic 50 MB,
Nitro 500 MB; boost L2 50 MB / L3 100 MB — usar o valor configurado, nunca assumir Nitro):

| Caso | Ação |
| --- | --- |
| ≤ limite | reenviar como arquivo |
| imagem ≤ limite | enviar como arquivo **e** como `embed.image` (preview imediato) |
| > limite, compressível (texto, JSON, CSV, código, docs) | `tar.gz`; se ainda > limite → particionar (`part001…partNNN`, ~19 MB cada) e enviar mensagem-cabeçalho com instrução de remontagem: `cat part* > arquivo.tar.gz && tar xzf arquivo.tar.gz` |
| > limite, já comprimido (vídeo, imagem pesada, zip) | **não** recomprimir; enviar thumbnail (se imagem) + mensagem de aviso com link direto do Papo (`{PAPO_BASE_URL}`) e tamanho original |
| > limite no Papo (limite não documentado) | mesma estratégia invertida, ou hospedar no media server do bot e enviar URL |
| > 10 arquivos na mensagem | agrupar em blocos de 10 (limite Discord), mesma `chunk_total` |
| `moderation_status = blocked` | **não** bridgear; registrar no audit log |
| `moderation_status = sensitive` | bridgear com aviso explícito no embed (`⚠️ conteúdo sensível`) |
| `pending` / `processing` | bridgear normalmente: o Papo também mostra e serve o arquivo durante a inferência (`GET /attachments/{id}` só recusa `blocked`, com 410). Se o veredito for `blocked`, o Papo apaga a mensagem inteira e o `message_delete` apaga a cópia do outro lado |

**Mídia que o Discord hospeda** (`cdn.discordapp.com` / `media.discordapp.net` em `/attachments/…`,
`/embeds/…`): a URL é volátil e o hotlink é bloqueado. Ela nunca vira embed no destino: o bridge
baixa e re-envia como anexo, pelo mesmo caminho dos anexos (acima). Vale também para o link de
arquivo colado no texto da mensagem. Com `bridge_attachments = 0` não há para onde re-hospedar, e
o preview mantém a URL.

**O link de anexo é assinado.** Desde dez/2023 o CDN só serve `/attachments/` e `/embed/attachments/`
com `?ex=&is=&hm=` válidos — `ex` é o epoch de expiração em hexadecimal, ~24h. Sem parâmetro, ou com
`ex` no passado, o CDN responde 404 *"This content is no longer available"* **com o arquivo vivo**: é
o que acontece com o link limpo que o Discord entrega ao copiar, com o GIF de favorito (o embed aponta
para o caminho original, sem assinatura) e com um job que volta para a fila depois que a assinatura do
payload expirou. Por isso 404 nunca é tratado como "arquivo morto" na primeira tentativa:

1. `discordLinkIsStale` decide antes de ir à rede: link sem assinatura ou com `ex` vencido é renovado
   primeiro — bater no 404 certo seria só desperdiçar uma ida.
2. A renovação é `POST https://discord.com/api/v9/attachments/refresh-urls` com `{attachment_urls:[url]}`
   e o token do bot (aceito; se `Bot <token>` for recusado, o token cru é re-tentado). A leitura aceita
   as duas formas que o endpoint já respondeu: `refreshed_urls[{original, refreshed}]` e
   `asset_lookup[sha256(caminho)].updated`. O resultado é cacheado por **caminho** até o `ex` vencer, e
   uma renovação em andamento é compartilhada: o mesmo GIF de favorito, que muita gente manda ao mesmo
   tempo, paga uma chamada só.
3. Persistiu o 404 depois da renovação: `SourceGoneError` — o anexo é omitido com aviso no texto
   (`⚠️ anexo "…" não está mais disponível na origem`) e **a mensagem continua bridgeada**. Perder um
   arquivo não é motivo para perder a cópia inteira; o job não vai para `dead`.
4. 429/5xx e erro de rede continuam `RetryableError`: volta para a fila, a mídia não é descartada.

Os outros caminhos do CDN (`/emojis/`, `/stickers/`, `/embeds/`, avatares) não são assinados e não
expiram — não passam por renovação.

Cache de mídia em disco (`media_cache(sha256, path, mime, size_bytes, source)`) para:
reuso de avatar, retries sem novo download, e URLs estáveis no media server.

---

## 8. Embeds e link previews

Mapeamento Discord Embed → Papo `EmbedInput`:

| Discord | Papo | Observação |
| --- | --- | --- |
| `title` (256) | `title` (256) | idêntico |
| `description` (4096) | `description` (4192) | truncar no mínimo comum |
| `url` | `url` | manter a URL original |
| `color` (int) | `color` (`#RRGGBB`) | conversão |
| `author.name` / `author.url` | `author.name` / `author.url` | idêntico |
| `author.icon_url` | `author.icon_url` | backend do Papo baixa e re-serva (`embeds.author_media`); o card usa esse ícone no selo da linha de topo |
| `thumbnail.url` / `image.url` | `thumbnail.url` / `image.url` | Papo baixa e re-serva (HTTPS + allowlist de MIME) |
| `video` | `video` | Discord raramente expõe vídeo direto; se houver, `mime_type` obrigatório |
| `footer.text` | `footer.text` | usado também para data/origem |
| `fields[]` | `fields[]` | 25 fields, name 256 / value 1024 nos dois |

**Exceção — mídia hospedada pelo Discord.** `thumbnail`/`image`/`video` cuja URL é do CDN do Discord
(`cdn.discordapp.com` / `media.discordapp.net` em `/attachments/…`, `/embeds/…`) não entram no embed
do Papo: a URL expira junto com a mensagem original e o hotlink é bloqueado, e o backend do Papo
não consegue re-servi-la depois. O bridge baixa e re-envia como **anexo** da mensagem
(`discordHostedMedia` e `discordMediaLinksInContent`, em `previews.ts`) — inclusive o link de
arquivo colado no texto. O preview que só existia por essa mídia sai do card. Avatar e banner
(`author.icon_url`) ficam fora da regra: são imagem de identidade, caminho `/avatars/…`, e o
backend do Papo já re-serva (`author_media`). Preview que chega tarde (`message_edit`) é o único
caso em que a mídia não pode ser anexada — o Papo não aceita anexo em `PUT /messages/{id}` — então
ela sai do card e a URL da página continua como link.

Mapeamento Papo Embed → Discord Embed: espelho do acima; `source_type='link'` (preview
automático do Papo) é recriado no Discord **deixando a URL nua no `content`** — o Discord gera o
preview sozinho (exige permissão *Embed Links*). Alternativa: recriar o embed explicitamente e
enviar a mensagem com `flags: SUPPRESS_EMBEDS` quando o preview duplicar.

Formato do embed "mensagem bridgeada" (padrão nos dois lados):

```
Discord embed:
  author:  { name: "<nickname|username>", icon_url: <avatar Papo>, url?: <link> }
           (sem media server público: icon_url = attachment://avatar-<sha256>.<ext>,
            com o avatar enviado como anexo da própria mensagem)
  title:   (opcional, quando o conteúdo tem link)
  description: <conteúdo traduzido>
               (linha final quando há reações: `↳ 👍 3 · <:papu:1234> 1`)
  fields:  (opcional)
  image:   <anexo imagem>
  footer:  { text: "🕒 09/10/2026 14:03 · Papo #geral · msg 1/2" }
  color:   cor fixa configurável por canal-link

Papo embed (EmbedInput):
  author:  { name: "<displayName>", icon_url: https://cdn.discordapp.com/avatars/<id>/<hash>.png }
  site_name: "<displayName>"        (linha de topo; o avatar ocupa o selo dessa linha)
  description: <conteúdo traduzido>  (a mensagem do Papo sai sem `content`;
               linha final `↳ 👍 3 · :papu: 1` quando há reações)
  thumbnail: (somente imagem de conteúdo; nunca avatar)
  image:   { url: https://cdn.discordapp.com/attachments/... }
  footer:  { text: "🕒 09/10/2026 14:03 · Discord #geral · msg 1/2" }
  color:   "#5865F2"
```

No Papo a mensagem bridgeada sai **sem `content`**: o texto vai no `description` do embed, então
o card é a mensagem (sem bolha de texto duplicada na frente do card). Consequência aceita: a
mensagem ponte não é pesquisável no Papo — a pesquisa do lado Discord acontece no Discord.

O card do Papo renderiza `description` com o **mesmo renderizador do corpo de mensagem**
(`renderMessageMarkdown`): markdown, `:emoji:` custom e `@mention(<@uuid>)` aparecem formatados.
Sem isso o texto da ponte chegava como texto cru — `:sadge:` literal, negrito visível, menção crua.
Notificação de menção continua exigindo `content` (o trigger do Papo lê só `content`), e no Discord
menção em embed renderiza como chip sem notificar: é limite das duas plataformas, não do bridge.

---

## 9. Chunking (mensagem que estoura limite)

Orçamento por mensagem-destino:

```
content (Papo): 8192 chars (confirmado no backend) → usar 7936 para sobrar espaço de notas
description do embed: 4096 (Discord) / 4192 (Papo) → usar limit = 3600 por chunk
embed total:    6000 chars (soma title+description+fields+footer+author) — igual nos dois lados
embeds/mensagem:10
arquivos/mensagem: 10
```

Algoritmo `chunkText(text, limit)`:

1. Alvo: conteúdo principal na **embed description** (4096 no Discord / 4192 no Papo), com
   orçamento global de 6000 por mensagem → usar `limit = 3600` por chunk para sobrar espaço de
   footer/fields.
2. Cortar na ordem: parágrafos (`\n\n`) → linhas → sentenças → palavras → corte duro com `…`.
3. **Nunca cortar dentro de code fence**: se a cerca está aberta no corte, fechar com ``` no fim
   do chunk e reabrir com a mesma linguagem no início do próximo.
4. Nunca cortar dentro de link `[t](u)`, menção ou emoji multi-codepoint (grafeme cluster).
5. Emitir N mensagens com rodapé `msg i/N`; encadear com `reply_to` no Papo (mantém contexto) e
   no Discord responder o chunk anterior quando `bridge_replies = true`.
6. `message_map` guarda `(origem, message_id, chunk_index, chunk_total)` → edição só re-bridgea
   os chunks necessários e apaga os excedentes.

Edição: reenviar chunks e apagar os que sobraram (`DELETE /messages/{id}` no Papo,
`channel.messages.delete` no Discord). Deleção: propagar e apagar todos os chunks.

---

## 10. Buffer (outbox), retries e ordem

```sql
CREATE TABLE outbox (
  id           INTEGER PRIMARY KEY,
  link_id      INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  direction    TEXT    NOT NULL CHECK (direction IN ('to_discord','to_papo')),
  kind         TEXT    NOT NULL,              -- message | edit | delete | reaction | pin
  payload      TEXT    NOT NULL,              -- JSON normalizado
  dedupe_key   TEXT    NOT NULL UNIQUE,       -- ex.: "papo:<msg_id>:to_discord:0"
  state        TEXT    NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','in_flight','done','failed','dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  next_retry_at TEXT   NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  done_at      TEXT
);
CREATE INDEX ix_outbox_due ON outbox (state, next_retry_at, id);
```

Regras:

- **Ordem**: um outbox worker por `link_id`, FIFO por `id`. Nunca paralelizar chunks do mesmo
  canal (preserva ordem de conversa).
- **Retry**: backoff exponencial com jitter `1s, 2s, 4s, 8s … teto 15 min`, respeitando
  `Retry-After` do Discord.
- **Erro transitório** (429, 5xx, timeout, WS desconectado) → `pending` com `next_retry_at`.
- **Erro permanente** (403 sem permissão, canal deletado, 404 de canal, payload inválido) →
  `dead` + audit log + alerta em `/status` (nunca descartar silenciosamente).
- **Idempotência**: `dedupe_key` único + `message_map` único por mensagem de origem → restart não
  duplica. `in_flight` com timeout volta para `pending` na inicialização.
- **Backfill**: ao subir, Papo → `GET /channels/{id}/messages?since=<last_seen>&order=asc`;
  Discord → `GET /channels/{id}/messages?after=<last_discord_id>` (opcional, controlado por
  `backfill_on_start`).

### 10.1 Nada é decidido com o destino indisponível

O payload do job guarda os valores **da origem**; tudo que depende do destino é resolvido na
execução, quando o destino está acessível:

| Decisão | Quando acontece |
| --- | --- |
| emoji do Papo → token do guild | em `applyReaction`/`sendToDiscord`, não no evento WS |
| emoji do Discord → emoji do Papo (import `POST /emojis`) | em `applyReaction`/`sendToPapo` |
| download de anexo | em `execute` (o job só carrega `SourceRef`) |
| contagem de reação no resumo | em `applyReaction`, antes de tentar a reação nativa |

Se o destino ainda não está pronto, o job lança `RetryableError` e volta para `pending` com
backoff — em vez de virar `dead` ou ser descartado:

- guilds ainda sem emojis no cache (`client.guilds.cache.size === 0`) → re-tenta;
- mensagem de destino ainda não mapeada (a mensagem está na própria fila) → re-tenta;
- Discord 429/5xx, Papo 5xx, rede caída → re-tenta.

### 10.2 Eventos fora de ordem

`react_update` e `message_pin` do Papo **não trazem `channel_id`**: sem `message_map` não existe
como saber para qual link enviar. Esses eventos vão para `deferred_events` e são enfileirados na
fila do link no instante em que `sendToDiscord` cria o mapeamento (`flushDeferred`). Edit/delete
têm `channel_id`, então são enfileirados direto e re-tentam até o mapeamento aparecer.
Evento adiado sem bridge há mais de 6 h é descartado no tick de `drain`.

---

## 11. Modelo de dados (SQLite)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- cursors, bot ids, versão

CREATE TABLE users_papo (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, nickname TEXT,
  avatar_sha TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users_discord (
  id TEXT PRIMARY KEY, username TEXT, display_name TEXT,
  avatar_hash TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE user_links (
  papo_user_id    TEXT NOT NULL REFERENCES users_papo(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES users_discord(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (papo_user_id, discord_user_id)
);

CREATE TABLE server_links (
  papo_server_id  TEXT PRIMARY KEY,
  discord_guild_id TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE channel_links (
  id                 INTEGER PRIMARY KEY,
  papo_channel_id    TEXT NOT NULL UNIQUE,
  discord_channel_id TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'both'
                     CHECK (mode IN ('both','to_discord','to_papo')),
  identity           TEXT NOT NULL DEFAULT 'embed'
                     CHECK (identity IN ('embed','webhook')),
  bridge_attachments INTEGER NOT NULL DEFAULT 1,
  bridge_embeds      INTEGER NOT NULL DEFAULT 1,
  bridge_reactions   INTEGER NOT NULL DEFAULT 1,
  bridge_edits       INTEGER NOT NULL DEFAULT 1,
  bridge_deletes     INTEGER NOT NULL DEFAULT 1,
  bridge_pins        INTEGER NOT NULL DEFAULT 0,
  propagate_mentions INTEGER NOT NULL DEFAULT 0,
  color              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE message_map (
  id                INTEGER PRIMARY KEY,
  link_id           INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('papo_to_discord','discord_to_papo')),
  papo_message_id   TEXT,
  discord_message_id TEXT,
  chunk_index       INTEGER NOT NULL DEFAULT 0,
  chunk_total       INTEGER NOT NULL DEFAULT 1,
  content_sha       TEXT,
  rendered          TEXT,      -- corpo enviado ao destino
  bridge_embed      TEXT,      -- JSON do embed enviado (permite re-renderir o embed)
  footer_base       TEXT,      -- rodapé base (data/origem), sem o resumo de reações
  -- cópia enviada pelo webhook do usuário: o texto mora no `content`, não em cartão
  webhook_copy      INTEGER NOT NULL DEFAULT 0,
  link_embeds       TEXT,      -- JSON do preview de link aplicado à cópia (atrás do cartão)
  -- nota de reply da cópia de webhook (`*Respondendo:[link] de @autor*`): webhook não responde mensagem
  reply_note        TEXT,
  -- rótulo do autor da mensagem de origem: o "de @autor" da nota de reply
  author_label      TEXT,
  edit_revision     TEXT,      -- revisão da última edição aplicada (edição atrasada não reverte)
  embed_revision    TEXT,      -- revisão da última atualização de preview aplicada
  deleted           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_map_papo    ON message_map (papo_message_id, chunk_index)    WHERE papo_message_id    IS NOT NULL;
CREATE UNIQUE INDEX ux_map_discord ON message_map (discord_message_id, chunk_index) WHERE discord_message_id IS NOT NULL;
CREATE INDEX ix_map_link ON message_map (link_id, created_at);

-- Contagem de reações da mensagem de origem, no formato exibível do destino
-- (unicode 👍 ou nome de custom :nome:, porque footer de embed não renderiza emoji custom).
CREATE TABLE reaction_counts (
  link_id           INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('papo','discord')),
  source_message_id TEXT NOT NULL,
  emoji             TEXT NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (link_id, source, source_message_id, emoji)
);

-- Reações aplicadas por nós no Papo: o `react_update` que isso dispara não traz quem
-- reagiu, então usamos esta tabela para reconhecer o eco e não devolvê-lo ao Discord.
CREATE TABLE self_reactions (
  link_id                INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  destination_message_id TEXT NOT NULL,
  emoji                  TEXT NOT NULL,
  applied_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (link_id, destination_message_id, emoji)
);

-- Eventos que chegaram antes da mensagem de origem estar bridgeada. São enfileirados na
-- fila do link quando o `message_map` aparece; sem isso a reação/pino se perderia.
CREATE TABLE deferred_events (
  id                INTEGER PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('papo','discord')),
  source_message_id TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('reaction','edit','delete','pin')),
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE emoji_map (
  name             TEXT PRIMARY KEY,          -- lowercase
  papo_emoji_id    TEXT,
  discord_emoji_id TEXT,
  discord_animated INTEGER NOT NULL DEFAULT 0,
  image_sha        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media_cache (
  sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, mime TEXT,
  size_bytes INTEGER, source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE presence_cache (
  platform  TEXT NOT NULL CHECK (platform IN ('papo','discord')),
  user_id   TEXT NOT NULL,
  status    TEXT NOT NULL,                    -- online | offline | away | busy
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, user_id)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL, event TEXT NOT NULL, payload TEXT
);
```

---

## 12. Fluxos

### 12.1 Papo → Discord
```
WS event {type:"message", id, channel_id, author_id, content, reply_to, attachments, created_at}
  → ignorar se author_id == bot_papo_user_id
  → canal-link existe e mode ∈ {both, to_discord}?
  → dedupe (message_map)
  → traduzir conteúdo (menções, emojis, timestamps)
  → resolver autor: GET /users/profile_batch (≤50) → nickname/username + avatar (cache por sha)
  → chunk (§9)
  → attachments: baixar (Range), filtrar por moderação, comprimir/particionar (§7)
  → reply_to da origem → cópia Discord em message_map → reply do Discord (sem cópia: sem reply)
  → INSERT outbox(to_discord) → worker → channel.messages.create({embeds, files, allowed_mentions:{parse:[]}})
  → INSERT message_map(papo_message_id, discord_message_id, chunk)
  (embeds de link chegam depois via message_embeds_update → atualizar o embed Discord correspondente)
```

### 12.2 Discord → Papo
```
MESSAGE_CREATE
  → ignorar bot/webhook próprio
  → canal-link? (thread linkada é canal como qualquer outro)
  → traduzir conteúdo + embeds (rich/link preview) + attachments
  → mídia hospedada pelo Discord (embed, preview ou link colado no texto) vira anexo baixado (§7, §8)
  → m.reference da origem → cópia Papo em message_map → reply_to do Papo (sem cópia: sem reply)
  → montar EmbedInput (author, thumbnail=avatar Discord, image=anexo, footer=data/origem)
  → multipart POST /messages {channel_id, content, embeds(JSON string), attachments[](binary), reply_to?}
  → message_map
```

### 12.3 Demais eventos
| Evento origem | Ação |
| --- | --- |
| `message_edit` / `MESSAGE_EDIT` | re-traduzir e atualizar chunks (se `bridge_edits`) |
| `message_delete` / `MESSAGE_DELETE` | apagar todos os chunks (se `bridge_deletes`) |
| `react_update` / `MESSAGE_REACTION_*` | traduzir emoji por nome e aplicar reação |
| `message_embeds_update` | atualizar preview do embed destino |
| `attachment_moderation_update` (`sensitive`) | adicionar aviso ao embed; `blocked` → apagar |
| `message_pin` / `MESSAGE_PIN` | opcional (`bridge_pins`) |
| `channel_create/update/delete` | alertar no canal de administração (não auto-criar canal) |
| `threadCreate` / `threadUpdate` | entrar na thread linkada (join); thread arquivada → registro no audit log |
| `avatar_update` / `GUILD_MEMBER_UPDATE` | invalidar cache de avatar |
| `presence_sync` / `presence_update` / `PRESENCE_UPDATE` | alimentar `presence_cache` (usa `/online`) |

### 12.4 Superfície do Discord conferida contra a discord.js 14.27

| Chamada | Estado | Observação |
| --- | --- | --- |
| `new Client({ intents, partials })` | ✅ | precisa de `GuildMessageReactions` para `messageReactionAdd/Remove`; sem ele o evento simplesmente não chega |
| `client.on('clientReady')` | ✅ | `ready` foi deprecado na 14.16; usar `clientReady` |
| `channel.send({ embeds, files, allowedMentions })` | ✅ | `allowedMentions` é camelCase; `allowed_mentions` seria ignorado |
| `reply: { messageReference, failIfNotExists }` | ✅ | `messageReference` no nível raiz **não existe** em `MessageCreateOptions` (14.x) — a lib ignora |
| `channel.messages.fetch(id)` → `message.edit/delete/react/pin/unpin` | ✅ | `pin/unpin` exigem `Manage Messages` |
| `ThreadChannel#join()` | ✅ | `members.add('@me')`; thread privada/anunciada não entrega mensagens a quem não é membro |
| `webhook.send/editMessage({ threadId })`, `webhook.deleteMessage(id, threadId)` | ✅ | thread não tem webhook próprio: o webhook é do canal pai e a mensagem entra na thread pelo `thread_id` |
| `MessageReaction#remove()` | ✅ | apaga a reação **do próprio bot** (DELETE sem user = `@me`) |
| `ReactionManager` | ✅ | tem só `removeAll()` e o cache; **não** tem `fetch()` — contagem vem do cache ou de `reaction.count` |
| `channels.fetch(id)` | ✅ | pode devolver `PartialGroupDMChannel`, que não tem `send`/`messages`; validar `instanceof TextChannel / NewsChannel / ThreadChannel` |
| `messageUpdate` com mensagem parcial | ✅ | `after.content` vem vazio quando a mensagem não estava no cache → re-buscar antes de editar o destino |
| `client.destroy()` | ✅ | não é deprecado (ainda não existe v15); aguardar no shutdown |
| `guild.commands.set()` / `application.commands.set()` | ✅ | por guild é imediato; global demora até 1 h a propagar |
| `Presence#status` | ✅ | vocabulário `online/idle/dnd/invisible` → normalizado para `online/away/busy/offline` |
| `channelPinsUpdate` | ❌ não usado | o evento não diz **qual** mensagem foi pinada; exige `fetchPinned()` + diff. Pino Discord → Papo continua fora da v1 |

### 12.5 Reply

O reply é propagado por referência mapeada, não por texto copiado:

| Origem | Referência lida | Destino |
| --- | --- | --- |
| Discord | `message.reference.messageId` → `message_map.discord_message_id` → `papo_message_id` | `POST /messages { reply_to }` |
| Papo | `message.reply_to` → `message_map.papo_message_id` → `discord_message_id` | `send({ reply: { messageReference, failIfNotExists: false } })` |

- Só o **primeiro chunk** carrega a referência; os chunks seguintes respondem ao chunk anterior
  (thread da própria mensagem particionada).
- Sem cópia mapeada não há reply: a mensagem respondida é anterior ao link, já foi apagada, ou o
  link está em modo unilateral. O job resolve a cópia na **execução**, não no enqueue — assim a
  mensagem respondida, que está na mesma fila FIFO, já tem `message_map` quando o reply é enviado.
- `reply_to` apontando para mensagem apagada dá 404 no Papo: o bot reenvia sem referência.
- Não copiamos o texto respondido no corpo do embed: os dois lados já renderizam o preview nativo
  (Discord mostra a mensagem referenciada, o Papo mostra o reply do próprio Papo).
- **Modo webhook não tem reply nativo** (o Discord não permite que webhook responda mensagem): a
  referência chega como `*Respondendo:[link da mensagem no Discord] de @autor*` no topo do
  `content` da cópia — o autor citado é o da mensagem respondida, lido de `message_map.author_label`
  (autor Papo quando a cópia é `papo_to_discord`, autor Discord quando é `discord_to_papo`; sem
  rótulo — cópia anterior à coluna — a nota fica só com o link). A nota fica em
  `message_map.reply_note` porque toda re-escrita do content (edição, resumo de reações) reescreve
  o `content` inteiro e precisa reescrevê-la junto. No envio pelo cartão o reply continua sendo
  reply nativo do Discord.

---

## 13. Comandos

Slash commands no Discord (registro global ou por guild), com controle de acesso
(`Manage Channels` para linkar).

| Comando | Efeito |
| --- | --- |
| `/online` | Lista quem está online na plataforma inversa (usa `presence_cache` dos dois lados) |
| `/link-channel papo_channel:<nome\|uuid> discord_channel:<canal\|thread>` | Cria/atualiza link 1:1 (o nome é resolvido em `GET /channels`); thread do Discord é linkável — do lado Papo ela vira canal |
| `/unlink-channel discord_channel:<canal>` | Remove o link (mantém histórico) |
| `/link-server papo_server:<nome\|uuid> discord_guild:<guild>` | Associa servidores (validado contra `GET /server`) |
| `/link-user papo_user:<nome\|uuid> discord_user:<usuário>` | Mapeia identidade (username/apelido resolvido em `GET /users`) |
| `/unlink-user discord_user:<usuário>` | Remove mapeamento |
| `/bridges` | Lista canal-links com estado, contadores e flags |
| `/bridge-config discord_channel:<canal> mode/identity/attachments/reactions/edits/deletes/mentions/color` | Ajusta flags do canal-link |
| `/status` | Saúde: sessão Papo (JWT), WS conectado, Discord conectado, outbox por estado, últimos erros |
| `/retry [dead]` | Re-enfileira itens `failed`/`dead` |
| `/sync-emojis discord_channel:<canal>` | Pré-importa emojis Discord usados → Papo e vice-versa |
| `/pause <canal>` / `/resume <canal>` | Pausa o bridge de um canal sem deslinkar |
| `/help` | Ajuda |

**Alias dos comandos de configuração**: `papo_server`, `papo_channel` e `papo_user` aceitam nome ou
uuid. O nome é normalizado (sem `#`/`@`, sem caixa) e casado contra `GET /server`, `GET /channels` e
`GET /users` (username e apelido); substring que casa com um único item é aceita, empate é recusado
com a lista de candidatos. Os ids resolvidos são os que vão para o SQLite.

**Resposta das interações**: o Discord exige a primeira resposta em 3 s; comandos que consultam o
Papo (`/link-channel`, `/link-server`, `/link-user`, `/bridges`) chamam `deferReply()` antes da
chamada e entregam o resultado por `editReply` — sem isso o callback vira `10062 Unknown interaction`.

Comandos Papo: o Papo não tem slash commands → espelho por **prefixo** na primeira linha da
mensagem do canal-link (ex.: `!status`, `!online`) respondido no próprio canal, ou apenas via
Discord (recomendado para v1).

---

## 14. Configuração

```jsonc
{
  "papo": {
    "baseUrl": "https://papo.example.com",
    "wsUrl":   "wss://papo.example.com/ws",
    "username": "wormhole",
    "password": "${PAPO_PASSWORD}",
    "refreshEveryHours": 12,
    "backfillOnStart": true
  },
  "discord": {
    "token": "${DISCORD_TOKEN}",
    "applicationId": "…",
    "guildId": "…",
    "identity": "embed",
    "maxFileBytes": 20971520,
    "intents": ["Guilds","GuildMessages","MessageContent","GuildMessageTyping","GuildPresences"]
  },
  "media": { "dataDir": "./data/media", "publicBaseUrl": "https://media.example.com" },
  "db": { "path": "./data/wormhole.sqlite" },
  "limits": { "chunkChars": 3600, "maxFilesPerMessage": 10, "maxEmbedsPerMessage": 10 },
  "emoji": { "autoImport": true, "maxBytes": 262144, "maxPixels": 512 },
  "outbox": { "maxAttempts": 12, "backoffBaseMs": 1000, "backoffMaxMs": 900000 },
  "adminChannelDiscordId": "…"
}
```

---

## 15. Rate limits e tratamento de erro

- **Discord**: respeitar `X-RateLimit-Bucket`, `X-RateLimit-Remaining`, `Retry-After`; bucket
  por canal (`~5 msgs / 5 s`), global por rota; webhooks sem limite oficialmente estável →
  bucket próprio conservador (≈20 req/min por webhook). Em 429, pausar o worker do canal-link
  até o reset (não re-tentar imediatamente).
- **Papo**: o backend aplica um limiter **global por IP** (`RATE_LIMIT=10` req/s, rajada
  `RATE_BURST=20`) a todas as rotas — inclusive o handshake do `GET /ws` — e não devolve
  `Retry-After`. O cliente usa um token bucket (`PAPO_RATE_LIMIT_RPS=8`, `PAPO_RATE_BURST=12`)
  compartilhado por todo o bridge, porque o teto é do IP e não do canal. 429/5xx re-agendam o
  job com backoff; 4xx de payload/permissão é permanente. Circuit breaker (3 falhas seguidas →
  pausa o canal por 60 s e alerta).
- **Degradação**: se o Papo está fora, o Discord continua sendo bridgeado para o outbox
  (fila cresce) e vice-versa; nunca bloquear um lado pelo outro além do limite de fila
  configurável (`maxQueuePerLink`).

---

## 16. Segurança e permissões

**Discord (bot)**: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Embed Links`,
`Attach Files`, `Add Reactions`, `Use External Emojis`, `Manage Webhooks` (modo B),
`Manage Threads` (entrar em thread privada/anunciada — sem ela o bridge só vê thread pública).
Intents: `Guilds`, `GuildMessages`, `MessageContent`*, `GuildMessageTyping`*, `GuildPresences`*
(*privilegiados — habilitar no developer portal; sem `MessageContent` o bridge não funciona).

**Papo (usuário-bot)**: role dedicada `wormhole` com `read_channel` + `send_messages` +
`send_attachment` nos canais linkados; `delete_messages` (edição/deleção), `pin_message`
(pins), `everyone_message` (se `propagate_mentions = true`). Criar emoji exige conta com
acesso a `POST /emojis` (confirmado: exige `manage_server`). Probe: sem `send_attachment` o
envio com anexo responde **403** (não 413), e sem `pin_message` o pino responde 403.

**Regras de segurança**:
- `allowed_mentions: {parse: []}` sempre; menções só quando explicitamente habilitadas.
- Nunca reenviar URL interna/host do Papo para o Discord além do necessário.
- Media server: servir apenas hashes já publicados, sem listagem de diretório, com TTL.
- Segredos só em variáveis de ambiente; JWT/cookie nunca em log.
- Sanitizar `content` antes de montar embed (evitar markdown quebrado e URLs encadeadas).

---

## 17. Observabilidade

- Logs estruturados (JSON) com `X-Request-ID` do Papo em toda chamada REST.
- Métricas: mensagens bridgeadas por direção, latência ponta a ponta, itens em `pending/failed/dead`,
  429 por minuto, falhas de mídia, emojis criados, tamanho de fila por link.
- `/status` (Discord) + health endpoint local (`/healthz`).
- Alerta no `adminChannelDiscordId` para: sessão Papo expirada, canal-link quebrado, item `dead`.

---

## 18. Edge cases

| Caso | Comportamento definido |
| --- | --- |
| Conteúdo > limite do destino | chunk em N mensagens com `msg i/N` (§9) |
| Code fence atravessando o corte | fecha e reabre a cerca com a mesma linguagem |
| Attachment > 20 MB | compressão `tar.gz` + partição, ou aviso + link (§7) |
| > 10 attachments | agrupa em blocos de 10 |
| Attachment com moderação `blocked` | não bridgea, registra audit |
| Múltiplos links na mensagem | manter URLs no texto; Discord gera preview do primeiro; no Papo o backend já gera até 10 embeds |
| Link sem preview (site sem OG) | texto puro, sem embed inventado |
| Embed do Discord com imagem em `proxy.discordapp.net` | passa a URL para o Papo baixar (HTTPS + MIME válido) |
| Autor Papo sem avatar | avatar default do bot / omitir `icon_url` |
| Autor Discord sem avatar | omitir `thumbnail` |
| Autor deletado/banido | `author.name = "usuário removido"`, sem crash |
| Autor banido no Papo | sessões revogadas → bridge continua só se o conteúdo já estiver em fila |
| Autor sem `/link-user` | modo espelho (nome/avatar no embed) |
| Reação com emoji que não existe no destino | Discord→Papo: importa via `POST /emojis` (exige `manage_server`); Papo→Discord: sem homônimo no guild, usa/cria emoji da aplicação (`ApplicationEmojiManager`); sem imagem ou com a criação recusada, só o resumo `:nome: N` no `description` |
| Reação removida | remove nos dois lados; `count = 0` no Papo remove a reação do bot no Discord e some do resumo |
| Reação/pino chega antes da mensagem ser bridgeada | guardado em `deferred_events` e enfileirado quando o mapeamento aparece (§10.2) |
| Guild sem emojis no cache (reconexão, guild indisponível) | o job de reação volta para a fila com backoff; a contagem do resumo é registrada na hora |
| Mensagem editada que agora estoura limite | re-chunk e apagar chunks excedentes |
| Mensagem deletada no destino manualmente | `message_map` marcado; edição vira recriação |
| Reply a mensagem não bridgeada | envia sem `reply_to`, com citação textual `> <autor>: <trecho>` |
| Reply a mensagem já deletada | idem (Papo aceita `reply_to` órfão, mas sem garantia) |
| Thread do Discord | linkável a um canal do Papo (`/link-channel`): o Papo não tem thread. O bridge entra na thread (join), envia pelo `thread_id` e o webhook é o do canal pai. Thread arquivada → registro no audit log; thread privada sem acesso → aviso |
| Canal Papo `voice`/`category` | não bridgea texto em category; canal voice aceita mensagem → bridge opcional |
| Canal deletado em um dos lados | marca link como `broken`, alerta admin, mantém fila até decisão |
| Bot reinicia no meio de um chunk | `dedupe_key` evita duplicar; `in_flight` volta a `pending` |
| Loop acidental (dois bots bridgeando) | filtro de autor + `message_map` + limite de profundidade 1 |
| Conteúdo só com emoji/sticker | mensagem com embed de mídia, sem `content` vazio |
| `content` vazio com attachment | permitido (attachment-only) |
| Timezone | sempre armazenar UTC; formatar no embed com timezone configurada |

---

## 19. Stack sugerida

- **Node.js + TypeScript**
- `discord.js` (gateway + REST + webhooks)
- `ws` (cliente `wss://…/ws` do Papo) + `fetch` (REST Papo, com cookie `Auth` próprio)
- `better-sqlite3` (WAL, transações síncronas simples para outbox)
- `sharp` (redimensionar emoji/avatar para os tetos 256 KB / 512 px)
- `tar` + `split` (compressão/partição de arquivos grandes)
- `zod` (validação de payloads e config), `pino` (logs)
- Deploy: Docker com volume para `data/` (SQLite + media cache)

Alternativa: Go (mesma linguagem do backend Papo) — menos atrito para reusar modelos, porém
ecossistema Discord menos maduro.

---

## 20. Roadmap

| Milestone | Entrega | Critério de aceite |
| --- | --- | --- |
| **M0 — Sondas** | script que confirma as dúvidas do §22 contra o backend real | respostas documentadas no repo |
| **M1 — Texto** | login Papo + WS + Discord, `/link-channel`, forward bidirecional de texto, anti-loop | 20 mensagens de ida e volta sem duplicata nem loop |
| **M2 — Identidade** | embed com avatar/nickname/data nos dois lados, cache de perfil e avatar | autor reconhecível em 100% das mensagens |
| **M3 — Chunking** | divisão de texto longo, code fence seguro, edição/deleção propagadas | texto de 12k chars chega íntegro e editável |
| **M4 — Mídia** | attachments, thumbnails, compressão+partição, previews de link | arquivo de 60 MB chega particionado e remontável |
| **M5 — Emojis e reações** | `emoji_map`, import automático, reações bidirecionais | emoji exclusivo de um lado aparece no outro |
| **M6 — Robustez** | outbox completo, backoff, backfill, `/status`, `/retry`, alertas | matar o processo no meio de uma fila e retomar sem duplicar |
| **M7 — Extras** | `/online`, `/link-user`, pins, modo webhook, threads | opcional, por demanda |

---

## 21. Fora de escopo (v1)

Voz/WebRTC, DMs, enquetes, stickers, roles sincronizadas, histórico
retroativo massivo (só backfill curto), busca cruzada, moderação cruzada. Thread do Discord é
linkável a um canal do Papo, mas não vira thread do outro lado (o Papo não tem thread) e thread
criada a partir do Papo não existe.

---

## 22. Perguntas em aberto (atualizado após leitura do frontend aero e do backend Go)

Confirmado no código local (`papo-frontend`, `papo-backend-infra/backend`):

1. **Emoji custom em `content`** — ✅ shortcode `:name:`. O frontend usa
   `/:([A-Za-z0-9_]+):/g` (`src/lib/utils/emojis.ts`); nome desconhecido permanece literal.
2. **Permissão de `POST /emojis`** — ✅ exige `manage_server` (`internal/handlers/emojis.go`).
   Sem esse role o bridge cai para `:name:` literal (sem importar a imagem).
3. **Limite de `content`** — ✅ **8192** caracteres (`internal/services/messages.go:38`).
4. **Limites de attachment** — ✅ 100 MB por arquivo, 10 por mensagem, nome ≤ 128 chars
   (`internal/services/attachments.go:29`, replicado em `papo-frontend/src/lib/utils/upload.ts`).
5. **Menção canônica** — ✅ `@mention(<@uuid>)` é o formato que o frontend renderiza como
   highlight (`src/lib/utils/markdown.ts`); `@everyone` só destaca se o autor tiver
   `everyone_message`.
6. **Markdown aceito pelo Papo** — ✅ CommonMark + GFM via `marked` (gfm, breaks). HTML cru é
   removido; `__sublinhado__` e spoiler `||…||` **não** existem; schemes de link permitidos:
   `http`, `https`, `mailto`.
7. **Embed no Papo renderiza `description` como texto puro** — ✅ (`EmbedCard.svelte`), por isso o
   corpo da mensagem bridgeada fica em `content` e o embed carrega só autoria/mídia.

Confirmado em execução contra uma instância local (M0 — `npm run probe -- --channel=… --burst=12 --attachments --ws=25`):

8. **Rate limits do backend Papo** — ✅ existe um limiter **global por IP** sobre todas as
   rotas (`cmd/main.go:173` → `middleware.RateLimit(cfg.RateLimit, cfg.RateBurst)`;
   `RATE_LIMIT=10` req/s com rajada `RATE_BURST=20`), **sem** `Retry-After`. O handshake do
   `GET /ws` também consome o bucket. Sem pacing, 12 mensagens em série → 429 na segunda;
   com o throttle do bridge (8 req/s, rajada 12) as 12 passaram (1,5 s). O bridge expõe
   `PAPO_RATE_LIMIT_RPS` / `PAPO_RATE_BURST` e trata 429 como transitório.
9. **Semântica de gap no WS** — ✅ nenhum evento traz id sequencial (`last_event_id` não
   existe); a recuperação continua sendo `GET /channels/{id}/messages?since=<cursor>`
   (`papo_cursor:<link_id>` em `meta`).
10. **`GET /embeds/{id}` → `image_data`** — ✅ é a **única** fonte dos bytes: o payload da
    mensagem traz `thumbnail`/`image` **sem `url`** (só `mime_type`, `width`, `height`,
    `size_bytes`). YouTube 384×288 webp → `image_data` de 13 456 chars base64. Embed custom
    com `thumbnail.url` é buscado e re-encodado pelo backend (PNG → webp 111×128) e depois
    servido como `image_data`. O bridge re-hospeda `image_data` no media server e usa essa URL
    como `thumbnail.url` do embed do Discord.
11. **`reply_to` para mensagem deletada** — ✅ `POST /messages` responde **404**
    ("reply_to referencia uma mensagem inexistente"). O bridge reenvia sem `reply_to` em vez de
    perder a mensagem.

Também confirmado nos probes:

| Fato | Evidência |
| --- | --- |
| limite de `content` | 8192 passa; 8193 → 400 |
| descrição de embed | máx **4192** (4193 → 400) |
| tipos de reação por mensagem | 20; a 21ª → 409 |
| `GET /reactions` | devolve `emoji_id`, `unicode`, `count`, `users[]` |
| eventos WS observados | `message` (sem `embeds`/`reactions`), `message_edit` (com `channel_id`), `message_delete` (com `channel_id`), `message_embeds_update` (`embeds` pode ser `null`), `react_update` (**sem `channel_id`**), `message_pin` (`{message_id, is_pinned}`, **sem `channel_id`**), `presence_sync` |
| eco | o WS entrega os eventos das mensagens do **próprio** bot → o filtro por `author_id` é obrigatório |
| anexo em canal | exige `send_attachment` no role; sem ela → **403** (não 413) |
| anexo acima de 100 MB | 400 "attachment excede o tamanho máximo de 100MB" |
| `GET /channels/{cid}/pinned` | chave `pinned` (não `messages`), ordem de fixação |
| pin / unpin | exigem `pin_message`; sem ela → 403 |
| `POST /emojis` | 201 com `manage_server`; `DELETE /emojis/{id}` remove |
| `emoji_id` inexistente em reação | 404 "emoji não encontrado" |
| embed custom | `author`, `footer`, `fields` e `color` sobrevivem ao round-trip |

---

## Apêndice A — Limites comparados

| Limite | Discord | Papo |
| --- | --- | --- |
| `content` por mensagem | 2000 (4000 Nitro) | **8192** (`services/messages.go`) |
| Embeds por mensagem | 10 | 10 |
| Soma de texto dos embeds | 6000 | 6000 |
| Título do embed | 256 | 256 |
| Descrição do embed | 4096 | 4192 |
| Fields por embed | 25 (name 256 / value 1024) | 25 (name 256 / value 1024) |
| Footer | 2048 | 2048 |
| Author name | 256 | 256 |
| URL | — | 2048 |
| Arquivos por mensagem | 10 | 10 (`services/attachments.go`) |
| Tamanho por arquivo | 20 MB free / 50 MB Nitro Basic / 500 MB Nitro (boost L2 50 MB, L3 100 MB) | 100 MB, nome ≤ 128 chars |
| Emoji custom | 250 por servidor, 256 KB, 256×256 | 500 por servidor, 256 KB, 512 px |
| Tipos de reação por mensagem | sem limite duro | 20 |
| Canais | — | 500 |
| Mensagens pinadas | — | 100 por canal |
| Paginação de leitura | `before/after` (snowflake) | `since` + `last_id` + `order` (100/página) |

## Apêndice B — Endpoints Papo usados

| Uso | Endpoint |
| --- | --- |
| Login / sessão | `POST /auth/login`, `POST /auth/login_server` (servidor privado), `POST /auth/refresh`, `GET /auth/whoami` |
| Listar canais | `GET /channels` |
| Histórico / backfill | `GET /channels/{channel_id}/messages?since&last_id&order` |
| Enviar mensagem | `POST /messages` (multipart: `channel_id`, `content`, `reply_to`, `attachments[]`, `embeds` = JSON string) |
| Editar / apagar | `PUT /messages/{id}`, `DELETE /messages/{id}` |
| Reações | `POST`/`DELETE /channels/{channel_id}/messages/{message_id}/reactions`, `GET` (lista) |
| Pins | `POST /channels/{channel_id}/messages/{message_id}/pin`, `GET /channels/{channel_id}/pinned` |
| Emojis | `GET /emojis`, `POST /emojis`, `DELETE /emojis/{emoji_id}` |
| Anexos | `GET /attachments/{file_id}` (Range), `GET /attachments/{file_id}/thumbnail` |
| Embeds | `GET /embeds/{embed_id}` (com `image_data`), `GET /embeds/{embed_id}/video` (relay) |
| Mídia (avatar/banner/ícone) | `GET /media/{sha_hash}` |
| Perfis | `GET /users/profile_batch` (≤50), `POST /users/user_summary_batch` (≤1000) |
| Presença | WS `presence_sync`, `presence_update` |
| Real-time | `GET /ws` (eventos da tabela abaixo) |

## Apêndice C — Eventos WebSocket do Papo relevantes

| Evento | Payload |
| --- | --- |
| `message` | `id, channel_id, author_id, content, reply_to, attachments, created_at` (sem `embeds`/`reactions`) |
| `message_edit` | `id, channel_id, content, edited_at` |
| `message_delete` | `id, channel_id` |
| `message_embeds_update` | `channel_id, message_id, embeds` (metadados, sem `image_data`) |
| `react_update` | `message_id, emoji_id, unicode, count` |
| `attachment_moderation_update` | `channel_id, message_id, attachment_id, status` |
| `message_pin` | `message_id, is_pinned` |
| `channel_create` / `channel_update` / `channel_delete` | metadados do canal |
| `avatar_update` | `user_id` |
| `presence_sync` / `presence_update` | presença (base do `/online`) |
| `heartbeat` / `heartbeat_ack` | keep-alive |
| `error` | `message, code?` |
