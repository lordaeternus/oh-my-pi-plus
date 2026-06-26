# Context Map Design

## Status

Spec curta para validação de produto e arquitetura antes do plano de implementação.

## Problema

O agente hoje descobre contexto principalmente lendo arquivos sob demanda. Em tarefas multi-arquivo, isso gera leituras exploratórias caras, repetidas e às vezes ruidosas. Um “Repo Map” sempre ligado resolveria parte disso, mas também criaria novos problemas: aumento fixo do prompt, quebra de prompt cache, excesso de confiança e ruído em tarefas pequenas.

## Objetivo

Criar um **Context Map** pequeno, adaptativo e cacheável que oriente o modelo sobre os arquivos e símbolos provavelmente relevantes para a tarefa atual, sem depender de CodeGraph.

O mapa deve reduzir leituras exploratórias e tokens gastos com descoberta, mas nunca substituir `read`, LSP, `search` ou CodeGraph quando precisão estrutural for necessária.

## Não-objetivos

- Não mapear o repositório inteiro por padrão.
- Não incluir corpos de funções.
- Não depender de CodeGraph.
- Não implementar PageRank/import graph no MVP.
- Não bloquear início da sessão por indexação longa.
- Não injetar summaries brutos do `read` no prompt.

## Decisões principais

1. O nome interno deve ser **Context Map**, não Repo Map.
2. O MVP usa fontes nativas/existentes: `workspace-tree`, `summarizeCode`, arquivos mencionados, arquivos lidos/editados, Git status/diff e proximidade de path/nome.
3. CodeGraph é apenas acelerador opcional quando disponível e saudável.
4. O bloco tem hard cap inicial de **800–1200 tokens**, medido com `countTokens` de `@oh-my-pi/pi-agent-core`.
5. O conteúdo é orientação, não autoridade. O prompt deve dizer que o agente ainda precisa verificar com ferramentas antes de editar.

## Abordagens consideradas

### A. Repo Map sempre ligado do projeto inteiro

Vantagem: simples de explicar e parecido com Aider.

Problemas: piora cache, consome tokens em tarefas pequenas, pode incluir muito ruído e incentiva o modelo a confiar em contexto desatualizado.

Decisão: rejeitada para o MVP.

### B. Context Map adaptativo sem CodeGraph

Vantagem: funciona para todos os usuários, usa infraestrutura já existente e mantém custo controlado.

Problemas: ranking inicial é heurístico, não semântico completo.

Decisão: recomendada para o MVP.

### C. Context Map com CodeGraph obrigatório

Vantagem: melhor precisão estrutural quando o índice existe.

Problemas: alguns usuários não terão CodeGraph instalado/indexado; cria dependência operacional pesada.

Decisão: rejeitada como requisito; aceita apenas como enhancement opcional.

## Arquitetura proposta

### 1. `context-map.ts`

Novo módulo responsável por:

- coletar candidatos;
- pontuar candidatos;
- extrair assinaturas compactas;
- renderizar bloco final;
- aplicar hard cap de tokens.

Interface sugerida:

```ts
export interface BuildContextMapOptions {
	cwd: string;
	budgetTokens?: number;
	userPrompt?: string;
	mentionedFiles?: readonly string[];
	readFiles?: readonly string[];
	editedFiles?: readonly string[];
	changedFiles?: readonly string[];
	signal?: AbortSignal;
}

export interface ContextMapResult {
	rendered: string;
	usedTokens: number;
	truncated: boolean;
	files: string[];
}

export async function buildContextMap(options: BuildContextMapOptions): Promise<ContextMapResult>;
```

### 2. Fontes de candidatos no MVP

Pontuar arquivos por sinais simples:

- arquivo mencionado diretamente pelo usuário;
- arquivo já lido na sessão;
- arquivo editado na sessão;
- arquivo modificado no Git/Jujutsu;
- arquivo próximo por diretório dos candidatos fortes;
- match semântico simples entre prompt e path/filename;
- arquivos recentes já disponíveis via workspace tree/listWorkspace.

### 3. Extração de assinaturas

Usar `summarizeCode` como base de parsing, mas não renderizar o summary bruto.

O renderer deve preferir:

- `export function`;
- `export class`;
- `export interface`;
- `export type`;
- métodos públicos relevantes;
- funções top-level com nomes que batem com a tarefa.

Deve evitar:

- corpos;
- comentários longos;
- constantes internas em massa;
- arquivos gerados/minificados;
- summaries não parseados;
- arquivos cujo summary não reduza bem.

### 4. Formato do prompt

Adicionar bloco separado perto de `<workspace-tree>`:

```xml
<context-map budget="1000" used="742">
The map below is repository-derived orientation, not verified source of truth.
Use read/search/LSP before editing.

packages/coding-agent/src/system-prompt.ts
- buildSystemPrompt(options: BuildSystemPromptOptions): Promise<BuildSystemPromptResult>

packages/coding-agent/src/workspace-tree.ts
- buildWorkspaceTree(cwd: string, options?: BuildWorkspaceTreeOptions): Promise<WorkspaceTree>
</context-map>
```

O bloco deve ser omitido se vazio.

### 5. Ativação

Ativar quando:

- tarefa menciona feature/área sem arquivo exato;
- tarefa parece multi-arquivo;
- usuário pede análise, planejamento, refactor ou implementação ampla;
- houve arquivos editados/lidos suficientes para melhorar orientação.

Pular quando:

- usuário apontou arquivo e linha exatos;
- tarefa é trivial/single-file;
- budget efetivo seria menor que 300 tokens;
- repo é pequeno o suficiente para workspace tree bastar;
- parsing excede timeout.

### 6. Cache e estabilidade

O Context Map deve preservar prompt cache.

Regras:

- não renderizar tempos relativos;
- ordenar deterministicamente por score, depois path;
- chave de cache inclui root, budget, versão do renderer e hashes dos arquivos renderizados;
- não incluir valores voláteis;
- timeout curto com fallback vazio.

### 7. CodeGraph opcional

Se CodeGraph estiver disponível e saudável, ele pode fornecer:

- symbols mais precisos;
- callers/callees;
- ranking por impacto;
- relação entre símbolos mencionados e arquivos.

Ausência, erro ou índice desatualizado não deve mudar o contrato: o fallback nativo continua funcionando.

## Métricas de sucesso

A feature só é sucesso se demonstrar pelo menos dois destes ganhos em avaliação local:

- menos chamadas exploratórias a `read` em tarefas multi-arquivo;
- menos tokens gastos antes da primeira edição correta;
- nenhum aumento relevante em tarefas pequenas;
- prompt cache estável entre sessões sem mudanças relevantes;
- tempo de preparação abaixo do timeout do system prompt.

## Validação já feita

- `summarizeCode` existe e já é usado no `read`.
- O cache atual de summary é por sessão, bounded LRU e baseado em hash de conteúdo.
- `workspace-tree` já usa renderização cache-stable com mtime absoluto.
- Medição em 40 maiores arquivos relevantes de `packages/coding-agent/src`, excluindo gerados/vendor/minificados:
  - full content: ~848.350 tokens aproximados;
  - structural summaries: ~104.989 tokens;
  - ratio: ~12,4%.
- Conclusão: summaries estruturais reduzem muito, mas summaries brutos ainda são grandes demais. O Context Map precisa ser signature-only e muito menor.

## Testes obrigatórios

1. Renderer respeita hard cap de tokens usando `countTokens`.
2. Renderer omite corpos de função.
3. Arquivos gerados/minificados/vendor/dist são excluídos.
4. Arquivo não parseado não quebra o mapa.
5. Ranking prioriza arquivo mencionado pelo usuário acima de arquivo apenas recente.
6. Output é determinístico para os mesmos inputs.
7. `buildSystemPrompt` omite `<context-map>` quando vazio.
8. `buildSystemPrompt` inclui `<context-map>` em bloco separado quando fornecido.

## Critérios para avançar ao plano

Esta spec está madura para planejamento quando:

- o MVP continua independente de CodeGraph;
- o orçamento padrão fica entre 800 e 1200 tokens;
- o prompt deixa claro que o mapa é orientação não verificada;
- o plano inclui testes de token budget, cache stability e fallback vazio;
- PageRank/import graph fica explicitamente fora do MVP.
