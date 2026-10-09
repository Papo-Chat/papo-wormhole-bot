# Papo Wormhole

Ponte bidirecional entre canais do Papo e canais do Discord:
mensagens, anexos, previews de link, edições, deleções, reações e emojis viajam nos dois
sentidos, preservando autoria (nome + avatar + data) e ordem de conversa.

> Estado: implementação da v1 concluída (M0–M6 do `BOT.md`); falta validar contra uma
> instância real do Papo (`npm run probe`).

## O que faz

| Recurso | Papo → Discord | Discord → Papo |
| --- | --- | --- |
| Texto (markdown) | embed com autor/avatar/data | `content` + embed de autoria |
| Anexos | reenviados; compactados ou particionados se não cabem | idem |
| Previews de link | embeds do Papo → embeds do Discord | embeds do Discord → embeds do Papo |
| Emojis custom | `:nome:` ↔ `<:nome:id>` | idem |
| Reações | reação nativa + contagem no rodapé do embed | idem |
| Edições / deleções | ✅ | ✅ |
| Pins | ✅ | opcional |
| Menções | texto simples (padrão) ou ping real (`propagate_mentions`) | idem |

Limites que moldam o bridge: Papo aceita `content` de **8192** caracteres, 10 anexos de até
100 MB; Discord aceita `content` de 2000, embeds somando no máximo 6000 caracteres e arquivos
de até 20 MB (conta free). Por isso o corpo Papo → Discord vai na **embed description** e
arquivos grandes são compactados (`gzip`/`tar.gz`) ou particionados.

## Requisitos

- Node.js **≥ 22.13** (usa `node:sqlite` embutido, sem flag — nenhuma dependência nativa).
- Um usuário comum do Papo para o bot (o Papo não tem contas "bot"): o bot é autor de tudo
  que envia ao Papo, e a identidade real viaja no embed.
- Um bot do Discord com **Message Content intent** habilitado no Developer Portal
  (privilegiado; sem ele o conteúdo das mensagens não chega).

## Instalação

```bash
git clone https://github.com/Papo-Chat/papo-wormhole-bot
cd papo-wormhole-bot
npm install
cp .env.example .env   # preencha credenciais e limites
npm run build && npm start
# ou, em desenvolvimento:
npm run dev
```

### Permissões do bot no Discord

`View Channels`, `Send Messages`, `Manage Messages` (edição/deleção/reações/pins) e
`Manage Channels` para os comandos de configuração. Se quiser usar emojis do guild no lado
Discord, `Manage Emojis` ajuda, mas não é obrigatório.

### Permissões no Papo

O usuário-bot precisa ser membro do canal linkado. Para importar emojis do Discord para o
Papo (`WORMHOLE_EMOJI_AUTO_IMPORT=true`) é necessário `manage_server`; sem isso o bridge cai
para o shortcode `:nome:` literal.

## Configuração (comandos)

```
/help                instruções
/link-channel        papo_channel:<uuid>  discord_channel:#canal
/unlink-channel      discord_channel:#canal
/link-server         papo_server:<uuid>
/link-user           papo_user:<uuid>  discord_user:@alguém
/unlink-user         discord_user:@alguém
/bridges             lista os canal-links e flags
/bridge-config       mode, attachments, embeds, reactions, edits, deletes, pins, mentions
/pause / /resume     interrompe/retoma um canal
/status              sessão + contagem da fila + últimos eventos
/retry               re-enfileira itens falhos (com dead=true, também os mortos)
/online              quem está online na plataforma inversa
```

Fluxo mínimo: `/link-channel` → pronto. O resto é ajuste.

## Arquitetura

```
Papo REST/WS ──► Bridge (tradução, chunking, embeds) ──► SQLite outbox ──► Discord API
                 ▲                                                        │
                 └────────────────── eventos Discord ◄───────────────────┘
```

- **Um worker serializado por canal-link** (FIFO por `id` na tabela `outbox`) preserva a
  ordem da conversa; links diferentes avançam em paralelo.
- **Anti-loop**: mensagens autoradas pelas próprias contas são descartadas e `message_map`
  tem índices únicos por `(message_id, chunk_index)`.
- **Anti-ping**: todo envio ao Discord usa `allowed_mentions: { parse: [] }`; menções só
  viram ping real quando `propagate_mentions` está ligado no canal-link.
- **Retenção**: falha transitória (429/5xx/timeout) volta para `pending` com backoff
  exponencial com jitter; falha permanente (400/403/404) vai para `dead` e pode ser
  reanimada com `/retry`.
- **Nada é decidido com o destino indisponível**: conversão de emoji, import de emoji e download
  de anexo acontecem na execução do job. Guild sem emojis no cache ou mensagem ainda não
  mapeada devolvem o job para a fila em vez de descartá-lo.
- **Eventos fora de ordem**: reação ou pino que chega antes da mensagem ser bridgeada fica em
  `deferred_events` e é enfileirada junto do envio que cria o mapeamento.
- **Mídia**: cache content-addressable (sha256) em `WORMHOLE_DATA_DIR/media`. O Discord exige
  URL absoluta para `author.icon_url`, então o avatar do autor Papo é servido pelo media
  server embutido (`WORMHOLE_MEDIA_BASE_URL`).

## Mapeamento de identidade

| Lado | Como a autoria aparece |
| --- | --- |
| Discord | embed author: `nickname > username` do Papo + avatar (via media server) + rodapé com data |
| Papo | embed author: `displayName` do Discord + avatar na thumbnail + rodapé com data |

`/link-user` liga as duas identidades para que menções possam ser propagadas.

## Desenvolvimento

```bash
npm run typecheck   # tsc em src, test e scripts
npm test            # vitest (chunking, tradução, embeds, tar, outbox, store)
npm run probe -- --channel=<uuid> --burst=12 --attachments --ws=20
npm run build
```

`npm run probe` roda os probes do M0 contra o backend Papo e imprime os limites reais
(tamanho de `content`, anexos, permissão de `POST /emojis`, rajada de mensagens, eventos WS).
Ele cria e apaga as próprias mensagens, marcadas com `[probe]`.

Resultados da última execução (instância local, backend Go atual):

| Item | Confirmado |
| --- | --- |
| `content` | 8192 passa, 8193 → 400 |
| descrição de embed | 4192 |
| anexos | 10 por mensagem, 100 MB por arquivo (101 MB → 400); enviar anexo exige `send_attachment` (sem ela → 403) |
| reações | 20 tipos por mensagem (a 21ª → 409) |
| rate limit | global por IP: 10 req/s, rajada 20, sem `Retry-After` — o handshake do WS conta |
| imagem do embed | o payload da mensagem não traz URL de thumbnail; os bytes só em `GET /embeds/{id}` (`image_data`) |
| `reply_to` apagado | 404 "reply_to referencia uma mensagem inexistente" |
| eventos WS | `message`, `message_edit`, `message_delete`, `message_embeds_update`, `react_update` e `message_pin` (ambos sem `channel_id`), `presence_sync` |

## Deploy

O bot é um processo único e stateless além do SQLite local. Exemplo com Docker:

```bash
docker build -t papo-wormhole .
docker run --env-file .env -v "$PWD/data:/app/data" -p 8787:8787 papo-wormhole
```

Se você expor o media server, publique-o atrás de HTTPS e defina `WORMHOLE_MEDIA_BASE_URL`
com a URL pública — sem isso o Discord não mostra o avatar do autor do lado Papo.

## Limites e escolhas documentadas

- Spoiler `||texto||` do Discord vira `**spoiler:** texto` (o Papo não renderiza spoiler).
- `__sublinhado__` do Discord vira `**negrito**` (o Papo não suporta sublinhado).
- Timestamp relativo `<t:…>` do Discord vira data absoluta no Papo.
- Arquivo que não cabe no destino e não é recomprimível (vídeo/imagem grande) vira aviso
  com link direto, para não estourar o limite do Discord.
- Reações viajam como reação nativa na mensagem de destino, e o rodapé do embed mostra a contagem
  (`🕒 09/10/2026 14:22 · Papo 1/2 · 👍 3 · ❤️ 1`). Quem reagiu não é transportado: a reação fica
  atribuída à conta do bridge nos dois lados.
- Emoji custom do Papo sem homônimo no guild do Discord não gera reação nativa (seria 400); aparece
  apenas como `:nome: 2` no resumo do rodapé.
- A imagem de um preview do Papo não tem URL pública: o bridge baixa `GET /embeds/{id}`
  (`image_data`) e re-hospeda no media server para o embed do Discord ter thumbnail.
  Requer `WORMHOLE_MEDIA_BASE_URL` configurada.
- Resposta do Papo a um `reply_to` já apagado é 404: o bridge reenvia a mensagem sem a referência
  em vez de descartá-la.
- As chamadas ao Papo passam por um token bucket (`PAPO_RATE_LIMIT_RPS=8`, `PAPO_RATE_BURST=12`)
  porque o limite do backend é por IP e vale para todas as rotas.
- Threads do Discord não são bridgeadas na v1.

Detalhes completos do design (incluindo o algoritmo de chunking e o esquema SQLite) estão em
[`BOT.md`](./BOT.md).

## Licença

AGPL-3.0 — ver [`LICENSE`](./LICENSE).
