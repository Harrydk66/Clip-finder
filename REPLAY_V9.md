# V9 experimento 1: Clip Worthiness para público frio

O V8.3 encontra acontecimentos reais; a hipótese V9 é que um judge com a decisão
editorial de publicar para desconhecidos melhora Acceptance@10. Este experimento
muda apenas a avaliação final do pool salvo. Discovery, cortes, participantes,
transcrições e os algoritmos V8/V8.3 permanecem iguais. A integração web acrescenta
rotas e uma reserva compartilhada entre os replays para impedir execuções concorrentes.
Não há migração, nova transcrição, áudio ou extração de frames.

## Usar pelo site — recomendado

Após publicar esta branch no Vercel e no worker Railway:

1. Abra a análise concluída. Também é possível usar `/?analysis=UUID_DA_ANALISE`
   para abrir o resultado em outro navegador ou dispositivo.
2. Clique em **Comparar com V9**. O botão requer o replay V8.3 concluído, porque
   a comparação de seleção precisa do pool persistido, além do Top10.
3. A página mostra o progresso; pode fechar e voltar depois. O worker usa as
   mesmas variáveis `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   e `WORKER_SECRET` já configuradas. Vercel usa `WORKER_URL` e `WORKER_SECRET`.
4. Quando terminar, assista aos intervalos e escolha **Postaria / Talvez /
   Não postaria**. Cada escolha é salva no banco e vale nas duas listas.
   A tela calcula Acceptance@10 após completar as avaliações de cada Top10.
5. Se houver falha ou reinício do worker, clique em **Retomar comparação V9**.
   Após dois minutos sem atualizações o botão de retomada aparece; a reserva
   no banco impede uma segunda execução enquanto a primeira estiver ativa.

A comparação é persistida em `analysis_jobs.result.v9`, incluindo snapshot,
cache, diagnósticos e avaliações humanas. `result.candidates`, `algo_version`,
status e os demais campos da análise V8.3 são preservados. Repetir a solicitação
de uma comparação concluída da mesma versão devolve o resultado salvo sem custo.
Um novo replay V8.3 exige uma nova comparação; a anterior fica em `v9History`
com diagnósticos e votos, sem duplicar transcrições/cache. A API pública omite
snapshot, cache e histórico nas consultas de progresso.

Um candidato sem texto sobreposto ao intervalo salvo não interrompe os demais.
Ele fica em `coverage.unavailable`, com identificação, posição anterior, limites
e extensão temporal do texto disponível; não recebe nota ou decisão editorial e
não consome chamada ao judge. O V9 ordena apenas os elegíveis, sem alterar o pool
original do snapshot nem inventar texto a partir do resumo. A interface explicita
a cobertura parcial e a lista de trechos não avaliados. Nessa situação, a diferença
de Acceptance@10 também pode decorrer da falta de dados; não deve ser atribuída
somente ao judge. Se restarem menos de dez cortes, Acceptance@10 permanece null.

As rotas do worker exigem a autenticação existente; as chaves nunca vão para o
navegador. O projeto mantém seu modelo atual de acesso às análises por UUID.
Nenhuma nova chave ou instalação no computador do usuário é necessária.

O site e o worker precisam da mesma atualização. Antes de testar, confira
`v9Comparison: true` no `/health` do worker e a presença do botão no site.
Esta atualização inclui Next.js 15.5.26, um patch de manutenção da série usada
pelo projeto, após o instalador alertar sobre vulnerabilidade em 15.5.7.

## Rodar o replay

Na raiz deste checkout, use Node.js 22 ou posterior. Os scripts V9 usam apenas
módulos nativos; não é necessário instalar as dependências do worker.

1. Escolha o UUID de uma análise **concluída** (`analysis_jobs.id`, não UUID do VOD).
   Para comparar o pool Top60 do V8.3, essa análise precisa ter
   `result.replayRunId` e suas linhas `candidate_trace.stage=pairwise_final`.
   O script confere que o Top10 desse trace é o mesmo resultado salvo.
2. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OPENAI_API_KEY` no
   ambiente local. São os valores já usados pelo worker. Não cole chaves no código,
   nos comandos compartilhados ou no Git. A chave do Supabase é privilegiada, mas
   este script só executa GET. Não é preciso `WORKER_SECRET` nem acesso ao vídeo.
3. Execute, substituindo o UUID:

```sh
node worker/replay-v9.js --job UUID_DA_ANALISE --out work/v9-resultado.json --review-out work/v9-labels.json
```

No PowerShell, variáveis de ambiente usam `$env:NOME = "valor"`. Para uma chave
digitada sem aparecer no histórico de comandos, prefira:

```powershell
$env:SUPABASE_URL = Read-Host 'SUPABASE_URL'
$env:SUPABASE_SERVICE_ROLE_KEY = Read-Host 'SUPABASE_SERVICE_ROLE_KEY' -MaskInput
$env:OPENAI_API_KEY = Read-Host 'OPENAI_API_KEY' -MaskInput
```

`-MaskInput` requer PowerShell 7.1+. As chaves ficam no ambiente desta sessão.
Use `--model NOME` para fixar o modelo. Sem isso: `V9_JUDGE_MODEL`, depois
`RANKING_MODEL`, depois `gpt-4o-mini`. Para isolar o prompt, use o mesmo modelo do
ranking antigo quando souber qual foi; o trace legado não registra esse modelo.

**Este comando é a alternativa local ao botão Comparar com V9.** O outro botão,
**Reprocessar com V8.3**, continua executando o replay antigo. A execução por CLI
grava um resultado local, não atualiza o resultado V9 no site. O arquivo contém transcrições: guarde-o como
dado privado e não o adicione ao repositório.

## Custo, falhas e repetição

Até 60 chamadas ao novo judge: uma por candidato sem cache, sem torneio pairwise.
O custo monetário depende do modelo e tamanho dos textos. `cache` guarda também
uso de tokens retornado pela API. O snapshot é gravado antes da primeira chamada,
e cada julgamento válido é salvo imediatamente. A primeira falha interrompe o
experimento, guarda o erro e não apresenta ranking parcial como concluído.

Retome o mesmo snapshot, inclusive sem Supabase disponível:

```sh
node worker/replay-v9.js --input work/v9-resultado.json
```

Se já terminou, esse comando reutiliza integralmente o cache, sem chamadas ao modelo.
Se falhou, precisa de `OPENAI_API_KEY` apenas para candidatos faltantes. Para gerar
o arquivo de labels após uma retomada, acrescente `--review-out work/v9-labels.json`
se ele ainda não existir. Arquivos de labels existentes nunca são sobrescritos.

Para comparar outro modelo mantendo o mesmo snapshot:

```sh
node worker/replay-v9.js --input work/v9-resultado.json --model OUTRO_MODELO --out work/v9-outro-modelo.json
```

Modelo, prompt/versionamento e evidência fazem parte da chave de cache. Mudá-los
gera novas chamadas. Para uma nova leitura do banco, use `--job` com outro nome
de saída. A retomada valida o hash do snapshot; não edite o resultado para criar
labels. Nenhum resultado novo sobrescreve um arquivo existente, exceto a retomada
explícita com `--input` no mesmo caminho.

## O que comparar

O resultado JSON contém:

- `snapshot`: pool congelado, limites dos trechos, transcrições, Top10 antigo,
  versão, ID do replay e horário da análise original.
- `ranked`: ranking V9 completo, `oldRank`, `v9Rank`, `rankChange`, score antigo,
  score de Clip Worthiness e os diagnósticos do novo judge.
- `diagnostics`: Event Value separado; standalone, cold hook, curiosity gap,
  universality, completion/payoff e dependência de contexto, cada qual com nota,
  razão e citações literais verificadas. Inclui decisão editorial, contexto ausente
  e incerteza. Descrições visuais já persistidas entram apenas como apoio.
- `cache`: respostas validadas e uso; `review`: modelo de avaliação humana;
  `metrics`: vazio de conclusões até receber os rótulos humanos.

Ordenação V9: Postaria antes de Talvez antes de Não postaria; depois média dos
cinco eixos de público frio conhecidos (0–100); empate mantém a posição antiga.
**Event Value não entra nesse score.** Zero é zero; desconhecido é `null`, nunca
nota inventada. `evaluatedAxes` mostra quantos eixos sustentam a média. Esta média
com evidência parcial não é probabilidade de viralizar nem métrica de aceitação.

Os timestamps atuais costumam cobrir segmentos de 120 segundos. Texto sobreposto
ao corte pode estar fora dele. Sem evidência que caiba nos primeiros 3 segundos,
`coldHook.score=null`. Isso pode impedir a decisão automática Postaria para todo
o pool: Postaria exige todos os cinco eixos >=3, dependência <=1 e evidência dentro
do trecho. O Top10 ainda é ordenado e pode ser validado manualmente, mas o judge
nesta situação avalia parcialmente a hipótese. Não conclua que hooks são ruins
pela falta de precisão temporal. Não se retranscreve para contornar essa limitação.

Em análises V8 sem trace de replay, o script compara **apenas o Top10 salvo**,
marcado `saved_top10_only`; não inventa a ordem das reservas. Nesse caso não pode
melhorar Acceptance@10 por seleção, apenas a ordem. Para testar troca de candidatos,
use uma análise V8.3 já persistida com mais de dez candidatos. Trace ausente,
inconsistente ou alterado durante a leitura causa erro, sem refazer o pipeline.

## Acceptance@10 manual

O arquivo `work/v9-labels.json` contém a união dos dois Top10 (até 20 trechos),
ordenada por tempo e sem notas/decisões dos judges, para reduzir viés. Abra o VOD
de `snapshot.vodUrl`, assista somente de `startSeconds` a `endSeconds` e preencha
`label` com **Postaria**, **Talvez** ou **Não postaria**. Use a pergunta: publicaria
este trecho para alguém que nunca viu a live? Não mude os limites entre variantes.
Pode preencher `notes`; preserve `key`. Julgue antes de ler os diagnósticos V9.

```sh
node worker/replay-v9.js --report work/v9-resultado.json --labels work/v9-labels.json --out work/v9-metricas.json
```

Acceptance@10 = número de **Postaria** / 10, calculado separadamente para o Top10
antigo e V9. Talvez não conta como aceito; aparece na contagem separada. Enquanto
faltar qualquer rótulo, a métrica é `null`. Pools menores que dez mostram somente
Acceptance@K, sem fingir uma medição @10. O mesmo candidato tem o mesmo rótulo nas
duas listas. Rótulos duplicados, desconhecidos e valores inválidos são rejeitados.

Melhoria só será demonstrada após essa avaliação em live nova; testes simulados
verificam implementação, preservação e custo de replay, não qualidade editorial.

## Verificações

```sh
node --test worker/replay.test.js worker/clip-worthiness.test.js worker/v9-web.test.js
```

Se criação de subprocessos estiver restrita, adicione `--test-isolation=none`.
As fixtures simulam Supabase e LLM, proíbem endpoints inesperados e escritas no
banco, testam recuperação/cache, evidências, ranking e Acceptance@10. Nenhum VOD
é acessado ou retranscrito.
