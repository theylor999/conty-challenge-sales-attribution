# Vendas atribuídas ao criador

Recebe webhooks de pedido e de estorno no formato da Shopify, atribui cada venda a no máximo um criador e mantém um livro-razão (ledger) só de inserções. Estorno zera ou reduz a venda do criador sem apagar nada.

Stack: Node 22+, TypeScript estrito, Hono, `node:sqlite`, vitest. Não precisa de Shopify real.

## Como rodar

```bash
npm install
npm run dev          # http://localhost:3000, banco em data/sales.db, criadores já semeados
npm test             # 102 testes
npm run typecheck
```

Variáveis: `PORT` (3000), `DB_PATH` (`data/sales.db`, ou `:memory:`), `SHOPIFY_WEBHOOK_SECRET` (se definida, todo webhook precisa de `X-Shopify-Hmac-Sha256` válido; sem ela a checagem fica desligada).

Criadores semeados (`src/seed.ts`):

| Criador | Cupons | Handle de UTM |
|---|---|---|
| `cr_ana` | `ANA10` | `ana` |
| `cr_bia` | `BIA15`, `BIAVIP` | `bia` |
| `cr_caio` | `CAIO20` | `caio` |

## API

| Rota | O que faz |
|---|---|
| `POST /webhooks/orders` | Ingere pedido (`201` novo, `200` repetido). Um pedido já conhecido só pode mudar para cancelado. |
| `POST /webhooks/refunds` | Ingere estorno (`201` aplicado/limitado/recusado, `202` pendente, `200` repetido). |
| `GET /orders/:id` | Atribuição com evidência e conflitos, totais, ledger completo, estornos e pendentes. |
| `GET /creators/:id/sales` | Bruto, estornado, revertido e líquido por moeda, mais a lista de pedidos. |

Erros: `401` assinatura inválida, `400` JSON inválido, `422` payload inválido (por exemplo `total_price` numérico ou com 3 casas).

Valores ficam em centavos inteiros (`*_cents`). `total_price` e `amount` chegam como string decimal e são lidos sem ponto flutuante (`"199.90"` vira `19990`). A moeda é gravada por pedido, e os totais do criador nunca somam moedas diferentes.

## Regra de atribuição

Uma função pura, `attributeOrder(order, directory)` em `src/domain/attribution.ts`. É o único lugar com a regra. Devolve `{creator_id, rule, evidence, conflicts}`.

Os candidatos são ordenados por intenção do comprador e o primeiro vence:

1. Cupom de criador, na ordem em que a Shopify lista os códigos. O comprador digitou no checkout.
2. `utm_content`, depois `utm_source`. A UTM pode vir de um clique antigo, então perde para o cupom.

As UTMs vêm de `landing_site` (caminho ou URL completa); `note_attributes` só preenche a chave que `landing_site` deixou vazia. Cupom e handle ignoram maiúsculas e espaços.

| Cupom de criador | UTM de criador | Resultado | `rule` | `conflicts` |
|---|---|---|---|---|
| Ana | Bia | Ana | `coupon` | Ana e Bia |
| Ana | Ana | Ana | `coupon` | vazio |
| Ana | nenhuma | Ana | `coupon` | vazio |
| desconhecido | Bia | Bia (o cupom fica na `evidence`) | `utm` | vazio |
| nenhum | Bia | Bia | `utm` | vazio |
| dois cupons, Caio e Ana | qualquer | Caio (primeiro da lista) | `coupon` | Caio e Ana |
| nenhum | nenhuma | sem criador | `none` | vazio |

`utm_content` e `utm_source` apontando para criadores diferentes: vence `utm_content`, conflito registrado.

A atribuição é congelada na primeira vez que o pedido chega. Pedido repetido ou atualizado não reatribui, mesmo que o diretório de cupons tenha mudado depois. Pedido sem criador também tem ledger; só não entra no total de ninguém.

## Idempotência

Duas camadas, as duas dentro da mesma transação do processamento:

- `X-Shopify-Webhook-Id` (a mesma entrega repetida): tabela `webhook_deliveries` com chave primária. Repetição devolve `duplicate_delivery` e não faz nada. Se o processamento falha, a transação desfaz e o id não é gasto, então o reenvio funciona. O header é opcional; sem ele só vale a camada seguinte.
- Chave de negócio (o mesmo pedido em uma entrega nova): `orders.id` e `refunds.refund_id` são únicos. Pedido repetido devolve `duplicate_order` sem novo lançamento. Estorno repetido devolve o registro original, mesmo que o valor do reenvio seja outro.

O banco reforça o resto: um índice único permite uma `sale` por pedido, um `reversal` por pedido e um lançamento por estorno. `BEGIN IMMEDIATE` serializa gravações, também entre processos.

Ids da Shopify de 64 bits passam de 2^53; o corpo é lido com esses ids como texto. `1001` e `"1001"` são o mesmo pedido.

## Ledger e estornos

`ledger_entries` é só de inserção (triggers bloqueiam `UPDATE` e `DELETE`). Valores assinados: `sale` positivo, `refund` e `reversal` negativos. Líquido = soma dos lançamentos.

- **Estorno parcial**: lança `refund` negativo; a `sale` continua lá. Várias transações `kind: "refund"` com `status` `success` (ou sem status) no mesmo estorno são somadas; outras são ignoradas. Estorno sem valor (só reposição de estoque) devolve `200 ignored`.
- **Estorno repetido**: mesmo `refund_id` não gera lançamento novo.
- **Teto**: a soma dos estornos aplicados nunca passa do valor da venda. Estorno acima do saldo é aplicado só até o saldo (`status: capped`, `applied_cents`) e o excedente fica em `excess_cents` com `reason: exceeds_remaining`. Sem saldo, `status: rejected`. Escolhi aplicar até o teto em vez de recusar tudo porque o estorno aconteceu de fato na loja, e o excedente continua rastreável. Um trigger no banco garante que o líquido do pedido nunca fica abaixo de zero.
- **Estorno antes do pedido**: fica `pending` com `received_at` e aparece em `GET /orders/:id` (`status: awaiting_order`). Quando o pedido chega, os pendentes são aplicados na mesma transação, por `created_at` (não por ordem de chegada), respeitando o teto. O mesmo estorno chegando duas vezes antes do pedido vale uma vez.
- **Moeda**: estorno em moeda diferente da do pedido é `rejected` com `reason: currency_mismatch`.
- **Cancelamento**: pedido com `cancelled_at` ou `financial_status: voided`, na chegada ou em atualização posterior, ganha um `reversal` do que ainda sobra (uma vez só). Cancelado não volta a ativo por webhook velho. Estorno que chega depois do cancelamento fica `rejected` (nada sobrou).
- `financial_status: refunded` sozinho não move dinheiro. Os valores vêm do webhook de estorno.

## Exemplos reais

Saída copiada de uma execução (`PORT=3057`); `...` marca trecho cortado por tamanho.

```bash
# pedido com cupom da Ana e UTM da Bia
curl -s -X POST localhost:3057/webhooks/orders -H 'content-type: application/json' -H 'x-shopify-webhook-id: d-1' -d '{"id":1001,"name":"#1001","total_price":"199.90","currency":"BRL","financial_status":"paid","discount_codes":[{"code":"ANA10"}],"landing_site":"/?utm_source=conty&utm_campaign=verao&utm_content=bia","created_at":"2026-03-10T10:00:00-03:00"}'
# 201 {"status":"created","order_id":"1001","creator_id":"cr_ana","rule":"coupon","conflicts":2,"applied_pending_refunds":[]}

# mesma entrega de novo (mesmo X-Shopify-Webhook-Id)
# 200 {"status":"duplicate_delivery"}

# mesmo pedido em entrega nova (d-2)
# 200 {"status":"duplicate_order","order_id":"1001","creator_id":"cr_ana","cancelled_now":false}

# estorno parcial de R$ 50,00
curl -s -X POST localhost:3057/webhooks/refunds -H 'content-type: application/json' -H 'x-shopify-webhook-id: d-3' -d '{"id":5001,"order_id":1001,"created_at":"2026-03-12T09:00:00-03:00","transactions":[{"amount":"50.00","kind":"refund","status":"success","currency":"BRL"}]}'
# 201 {"status":"applied","refund":{"refund_id":"5001","order_id":"1001","currency":"BRL","requested_cents":5000,"status":"applied","applied_cents":5000,"excess_cents":0,"reason":null,...}}

# o mesmo estorno em entrega nova
# 200 {"status":"duplicate_refund","refund":{"refund_id":"5001",...,"status":"applied","applied_cents":5000,...}}

# estorno de R$ 200,00 quando só sobram R$ 149,90
# 201 {"status":"capped","refund":{"refund_id":"5002",...,"requested_cents":20000,"status":"capped","applied_cents":14990,"excess_cents":5010,"reason":"exceeds_remaining",...}}

# estorno do pedido 1002, que ainda não chegou
# 202 {"status":"pending","refund":{"refund_id":"6001","order_id":"1002",...,"requested_cents":2000,"status":"pending","applied_cents":0,...,"resolved_at":null}}

curl -s localhost:3057/orders/1002
# {"id":"1002","status":"awaiting_order","order":null,"attribution":null,"totals":{"gross_cents":0,...},"ledger":[],"refunds":[{"refund_id":"6001",...}],"pending_refunds":[{"refund_id":"6001",...}]}

# o pedido 1002 chega (UTM da Ana, sem cupom): o pendente é aplicado na hora
# 201 {"status":"created","order_id":"1002","creator_id":"cr_ana","rule":"utm","conflicts":0,"applied_pending_refunds":[{"refund_id":"6001",...,"status":"applied","applied_cents":2000,...}]}

curl -s localhost:3057/orders/1001
# {"id":"1001","status":"known","order":{...,"total_cents":19990,...},
#  "attribution":{"creator_id":"cr_ana","rule":"coupon","evidence":{"coupons":[{"code":"ANA10","creator_id":"cr_ana"}],"utm":{"source":"conty","campaign":"verao","content":"bia"},"candidates":[...]},
#                 "conflicts":[{"source":"coupon","value":"ANA10","creator_id":"cr_ana"},{"source":"utm_content","value":"bia","creator_id":"cr_bia"}]},
#  "totals":{"gross_cents":19990,"refunded_cents":19990,"reversed_cents":0,"net_cents":0},
#  "ledger":[{"id":1,...,"kind":"sale","amount_cents":19990,...},{"id":2,...,"kind":"refund","amount_cents":-5000,"refund_id":"5001",...},{"id":3,...,"kind":"refund","amount_cents":-14990,"refund_id":"5002",...}],
#  "refunds":[...],"pending_refunds":[]}

curl -s localhost:3057/creators/cr_ana/sales
# {"creator_id":"cr_ana","name":"Ana Lima","totals":[{"currency":"BRL","orders":2,"gross_cents":27990,"refunded_cents":21990,"reversed_cents":0,"net_cents":6000}],"orders":[{"order_id":"1001",...,"net_cents":0},{"order_id":"1002",...,"gross_cents":8000,"refunded_cents":2000,"net_cents":6000}]}

# payload inválido
# 422 {"error":"invalid_payload","message":"total_price must be a decimal string such as \"199.90\""}
```

Bia (UTM do pedido 1001) não recebe nada: `GET /creators/cr_bia/sales` devolve `"totals":[],"orders":[]`.

## Testes

`npm test` (102 testes, vitest, banco em memória, relógio injetado):

- `attribution.test.ts`: a função pura, incluindo a tabela de desempate.
- `orders.test.ts`: pedido duplicado (mesma entrega e entrega nova), rajada concorrente, desempate de ponta a ponta, sem sinal, atribuição congelada, cancelamento.
- `refunds.test.ts`: parcial, repetido, acima do teto, estorno antes do pedido (uma e duas vezes, ordem por `created_at`), totais do criador depois de tudo.
- `db.test.ts`: o banco recusa segunda venda, estorno duplicado, líquido negativo, `UPDATE` e `DELETE` no ledger.
- `http.test.ts`: validação (422/400), HMAC, 404.
- `money.test.ts`, `ledger.test.ts`: parse exato e regras de teto.

## O que ficou de fora

- Cadastro de criadores e cupons por API: só semeados. Cupom não tem validade nem escopo de campanha.
- Edição de pedido (mudança de total): o valor da venda é o do primeiro webhook; redução entra por estorno.
- Atualizações fora de ordem além do cancelamento: status não cancelado segue o último webhook recebido.
- Estorno pendente de pedido que nunca chega fica pendente para sempre; não há expiração nem alerta.
- Estorno de pedido cancelado é recusado (o `reversal` já zerou); não distingo cancelamento com reembolso.
- Paginação das listas, autenticação das rotas de leitura, comissão e janela de atribuição.
- Os 64 bits dos ids são tratados por regex sobre `"id"` e `"order_id"` no corpo bruto, suficiente para o formato da Shopify.

## Uso de IA

Escrevi o código e os testes com um assistente de programação (Claude), que eu dirigi: defini as regras, ele escreveu e eu li cada arquivo. O que eu revisei e ajustei:

- Prioridade cupom sobre UTM e a lista de candidatos que alimenta `conflicts`: conferi que a regra existe em um só lugar e que o teste de ponta a ponta bate com o teste da função.
- Teto de estorno: decidi aplicar até o saldo e guardar o excedente, em vez de recusar o estorno inteiro, e pedi o trigger no banco além da checagem no serviço.
- Ids de 64 bits da Shopify e `1001` contra `"1001"`: conferi que o mesmo pedido não vira dois.
- Pedido que chega já cancelado e cancelamento depois de estorno parcial: revisei a conta do `reversal` para cobrir só o que sobra.
