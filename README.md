# Papo Wormhole

Ponte bidirecional entre canais do Papo e canais do Discord:
mensagens, anexos, previews de link, edições, deleções, reações e emojis viajam nos dois
sentidos, preservando autoria (nome + avatar + data) e ordem de conversa.

## O que faz

| Recurso | Papo → Discord | Discord → Papo |
| --- | --- | --- |
| Texto (markdown) | embed com autor/avatar/data | `content` + embed de autoria |
| Anexos | reenviados; compactados ou particionados se não cabem | idem |
| Previews de link | embeds do Papo → embeds do Discord | URLs no texto geram preview nativo no Papo; embeds personalizados de bots/webhooks sem URL no texto são convertidos |
| Emojis custom | `:nome:` ↔ `<:nome:id>`; sem o nome no guild, usa ou cria um emoji da aplicação | idem |
| Reações | reação nativa + contagem no `description` do embed | idem |
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
  (privilegiado; sem ele o conteúdo das mensagens não chega) e **Server Members intent**
  (necessário para resolver `@nome` do Papo em membros do guild; sem ele a resolução por
  nome do lado Discord fica desligada).

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

`View Channels`, `Send Messages`, `Send Messages in Threads`, `Manage Messages` (edição/deleção/
reações/pins), `Manage Channels` para os comandos de configuração e `Manage Webhooks` para o modo
webhook (nick + avatar do autor fixos no webhook; sem ela as cópias saem pelo cartão do bot).
Thread privada ou anunciada
só entrega mensagens a quem é membro: `Manage Threads` é o que permite ao bridge entrar nela
(thread pública não exige nada). Se quiser usar emojis do guild no lado
Discord, `Manage Emojis` ajuda, mas não é obrigatório: o fallback do bridge é o emoji da
aplicação, criado pela API do próprio app (`POST /applications/{id}/emojis`) — não precisa de
permissão nenhuma no servidor.

### Permissões no Papo

O usuário-bot precisa ser membro do canal linkado. Para importar emojis do Discord para o
Papo (`WORMHOLE_EMOJI_AUTO_IMPORT=true`) é necessário `manage_server`; sem isso o bridge cai
para o shortcode `:nome:` literal. Para que a cópia Discord → Papo saia pelo webhook do autor
(nick + avatar fixos no webhook) é necessário `manage_webhooks`; sem isso o bridge usa o cartão do
bot. Reações e pins continuam funcionando nas cópias de webhook: quem os aplica é o JWT do bot.

## Configuração (comandos)

```
/help                instruções
/link-channel        papo_channel:<nome ou uuid>  discord_channel:#canal | 🧵thread
/unlink-channel      discord_channel:#canal
/link-server         papo_server:<nome ou uuid>
/link-user           papo_user:<nome ou uuid>  discord_user:@alguém
/unlink-user         discord_user:@alguém
/bridges             lista os canal-links e flags
/bridge-config       mode, attachments, embeds, reactions, edits, deletes, pins, mentions
/pause / /resume     interrompe/retoma um canal
/status              sessão + contagem da fila + últimos eventos
/retry               re-enfileira itens falhos (com dead=true, também os mortos)
/online              quem está online na plataforma inversa
```

Em `papo_channel`, `papo_server` e `papo_user` serve o nome (`#geral`, `Cyber Asilo`, `@jonas`) ou o
uuid: o bot resolve o nome contra `GET /channels`, `GET /server` e `GET /users` (ignorando caixa,
`#`/`@` e aceitando substring única). Nome que casa com mais de um item é recusado com a lista de
candidatos — nesse caso o uuid resolve.

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
  server embutido (`WORMHOLE_MEDIA_BASE_URL`); sem ele o avatar é enviado como anexo da
  mensagem e o embed referencia `attachment://avatar-<sha256>.<ext>`.
- **Webhook por usuário (nos dois lados)**: cada autor tem um webhook próprio por canal, com
  nick + avatar fixos no webhook (nome `nickname (@username)`, ou só o username quando o apelido
  é o próprio nome). No modo webhook o bridge **não gera cartão**: `content` = o texto da mensagem
  de origem (com a linha de reações anexada quando existem) e a data é o timestamp nativo do
  destino. Os webhooks são criados sob demanda e reaproveitados entre runs por `bridge_webhooks`
  (Discord) e `papo_webhooks` (Papo) — registro de posse, que também identifica o eco sem chute
  por nome. Sem webhook (limite de webhooks do canal, bot sem *Manage Webhooks* no Discord ou sem
  a permissão `manage_webhooks` no Papo) o envio continua pelo cartão do bot. Edição e apagamento
  da cópia usam o token do webhook quando a mensagem é de webhook: nenhum dos lados deixa o JWT
  do bot mexer em mensagem de webhook.
  - **Papo → Discord**: os únicos embeds são os previews que vieram do Papo. Webhook não responde
    mensagens no Discord: a referência do reply chega como `*Respondendo:[link da mensagem] de
    @autor*` no topo do `content`.
  - **Discord → Papo**: o webhook do Papo responde mensagem, então o reply continua nativo
    (`reply_to`) e não vira nota no texto. Quando o `content` contém hyperlink, o bridge não
    converte o embed do Discord: mantém a URL para o backend do Papo gerar o preview nativo, sem
    duplicá-lo. A exceção são embeds personalizados publicados por bots ou webhooks quando o
    `content` não contém hyperlink; esses são convertidos para embeds do Papo. O envio leva
    `external_message_id` (chave de idempotência):
    re-tentar um job cujo resultado foi incerto devolve a cópia existente em vez de duplicá-la.
    O token do webhook é salvo em `papo_webhooks` porque o backend o mostra uma única vez, na
    criação.

## Mapeamento de identidade

| Lado | Como a autoria aparece |
| --- | --- |
| Discord | webhook do autor (nick + avatar) com o texto em `content`; sem webhook: embed author `nickname > username` do Papo + avatar (media server ou anexo `attachment://`) + rodapé com data |
| Papo | webhook do autor (nick + avatar) com o texto em `content`; sem webhook: embed author `displayName` do Discord no topo do card + avatar do Discord no selo do topo (`author_media`) + rodapé com data |

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
com a URL pública: é a forma mais limpa de o Discord mostrar o avatar do autor do lado Papo.
Sem essa variável o bot envia o avatar como anexo da mensagem (`attachment://avatar-<sha>.png`),
que também funciona, mas ocupa um dos dez anexos da mensagem.

### systemd

`scripts/deploy.sh` faz o ciclo completo: `git pull` → `npm install` → `npm run build` →
instala o unit, habilita e sobe o serviço.

```bash
scripts/deploy.sh              # serviço de usuário + linger (sobe no boot, sem login, sem sudo)
scripts/deploy.sh --system     # serviço de sistema em /etc/systemd/system (pede sudo)
scripts/deploy.sh --test       # roda a suíte de testes antes de subir
scripts/deploy.sh --no-service # só atualiza o código
```

O unit gerado (`~/.config/systemd/user/papo-wormhole.service`, ou `/etc/systemd/system/…` com
`--system`) roda `node dist/index.js` com `WorkingDirectory` no repositório — o `.env` é lido
de lá — e `Restart=always`. Logs e controle:

```bash
journalctl --user -u papo-wormhole -f        # --user cai com --system
systemctl --user status|restart|stop papo-wormhole
systemctl --user disable --now papo-wormhole       # remover o serviço
rm ~/.config/systemd/user/papo-wormhole.service && systemctl --user daemon-reload
```

O `git pull` é `--ff-only`: com alterações locais não commitadas ele para em vez de sobrescrever
trabalho (commite ou `git stash` antes).

## Limites e escolhas documentadas

- Spoiler `||texto||` do Discord vira `**spoiler:** texto` (o Papo não renderiza spoiler).
- `__sublinhado__` do Discord vira `**negrito**` (o Papo não suporta sublinhado).
- Timestamp relativo `<t:…>` do Discord vira data absoluta no Papo.
- Arquivo que não cabe no destino e não é recomprimível (vídeo/imagem grande) vira aviso
  com link direto, para não estourar o limite do Discord.
- Reações viajam como reação nativa na mensagem de destino, e o `description` do embed fecha com a
  contagem (`↳ 👍 3 · <:papu:1234> 1`). Quem reagiu não é transportado: a reação fica
  atribuída à conta do bridge nos dois lados.
- O resumo fica no `description` e não no rodapé porque footer de embed não renderiza emoji custom
  em nenhum dos lados: no Discord o `<:nome:id>` aparece cru, e no Papo o rodapé do card é texto
  puro. No `description` o emoji renderiza como imagem nos dois lados.
- Emoji custom do Papo sem homônimo no guild do Discord: o bridge procura o **emoji da aplicação**
  com o mesmo nome (`client.application.emojis`, carregado na conexão) e, se não houver, cria um a
  partir da imagem do emoji no Papo — 2000 por app, não ocupam slot do servidor nem exigem
  permissão. Renderiza no cartão do bot e na cópia do webhook, e o Discord aceita reação do bot com
  emoji do próprio app. Sem imagem para subir ou com a criação recusada, o registro aparece apenas
  como `:nome: 2` no resumo. Emoji do guild marcado `available: false` no Discord
  (69 no guild atual) também só aparece no resumo: o Discord recusa a reação com 10014.
- Menção só vira menção real quando o canal-link tem `mentions` ligado (`/bridge-config …`).
  Propagada, ela renderiza como chip clicável no card dos dois lados, mas não notifica: embed não
  gera ping no Discord e o trigger de notificação do Papo lê apenas `content`.
- Menção de quem não tem link de usuário vira nome (`@Ana`), não id: o bridge resolve o mencionado
  pelo payload do Discord (apelido do guild tem prioridade sobre o nome da conta) ou pelo batch de
  perfil do Papo. Sem como resolver, aparece `@usuário` — nunca o snowflake ou o uuid cru.
- Com `mentions` ligado, `@nome` em texto puro (digitado sem autocomplete) também tenta resolver:
  username/nickname exato e único no outro lado vira menção real; nome ambíguo (nickname dividido)
  permanece texto. Do lado Discord a busca usa o cache de membros do guild (Server Members intent);
  do lado Papo, a lista de usuários do backend. E-mail/URL com `@` não são candidatos.
- Reply é propagado por referência mapeada (`message.reference` ↔ `reply_to`): se a mensagem
  respondida não tem cópia do outro lado (anterior ao link, apagada), o reply simplesmente não vai.
- Attachment do Papo em análise de moderação (`pending`/`processing`) é reenviado normalmente — o
  Papo também mostra e serve o arquivo nesse estado. Se o veredito for `blocked`, o Papo apaga a
  mensagem e o bridge apaga a cópia junto.
- O card do Papo renderiza a descrição do embed com o renderizador de mensagem: `:emoji:`,
  markdown e menção aparecem formatados.
- A imagem de um preview do Papo não tem URL pública: o bridge baixa `GET /embeds/{id}`
  (`image_data`) e re-hospeda no media server para o embed do Discord ter thumbnail.
  Requer `WORMHOLE_MEDIA_BASE_URL` configurada.
- Resposta do Papo a um `reply_to` já apagado é 404: o bridge reenvia a mensagem sem a referência
  em vez de descartá-la.
- As chamadas ao Papo passam por um token bucket (`PAPO_RATE_LIMIT_RPS=8`, `PAPO_RATE_BURST=12`)
  porque o limite do backend é por IP e vale para todas as rotas.
- Servidor Papo privado (`GET /server` → `"public": false`): o backend recusa `POST /auth/login`
  com 401 `server-access-required` sem o token temporário (30 min) que `POST /auth/login_server`
  coloca no cookie `Auth`. Configure `PAPO_SERVER_PASSWORD` — é a senha do servidor, não a senha da
  conta do bot. `npm run check-auth` confirma o fluxo de sessão antes de subir.
- Mídia hospedada pelo Discord (`cdn.discordapp.com`, `media.discordapp.net`) nunca vira embed no
  Papo: o link de anexo é assinado (`?ex=&is=&hm=`) e vence em ~24h, e o hotlink é bloqueado. O
  bridge baixa o arquivo e re-envia como anexo da mensagem — vale para a mídia do embed/preview e
  para o link de arquivo colado no texto — e nesse caso **o link sai do texto**: embaixo do arquivo
  que chegou ele seria só uma URL que não abre fora do Discord. Link vencido é renovado em
  `attachments/refresh-urls` antes de desistir; arquivo que realmente não existe mais vira aviso no
  texto, e a mensagem continua bridgeada. Com `attachments` desligado não há para onde re-hospedar,
  e o link continua no texto e no preview.
- Thread do Discord é linkável a um canal do Papo (`/link-channel`), que é o que a thread vira do
  outro lado: o Papo não tem thread. O bridge entra na thread (o Discord só entrega mensagens de
  uma thread a quem é membro) e as cópias entram nela; webhook de thread é o do canal pai, com a
  mensagem enviada pelo `thread_id`. Thread arquivada é registrada na auditoria.

Detalhes completos do design (incluindo o algoritmo de chunking e o esquema SQLite) estão em
[`BOT.md`](./BOT.md).

## Licença

AGPL-3.0 — ver [`LICENSE`](./LICENSE).
