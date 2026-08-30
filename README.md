# Painel do BDR Genos

Painel de prospecção do time comercial: cada BDR lança o dia (leads, tentativas,
contatos, agendamentos, propostas, vendas) e o painel calcula meta da semana,
funil, as sete áreas do processo e a bonificação acumulada.

Roda no Cloudflare Workers. A página é um arquivo HTML só, e os lançamentos
ficam guardados no Cloudflare KV.

## Como está organizado

```
public/index.html   o painel inteiro (visual + contas). É o que a pessoa vê.
src/index.js        a API que guarda e devolve os lançamentos (/api/*).
wrangler.toml       a configuração do Cloudflare.
```

Quem entra no painel escolhe o perfil e digita um PIN de 4 dígitos. O PIN é
conferido no servidor, não no navegador. Quem acerta recebe uma sessão que vale
12 horas.

| Perfil | Papel | PIN inicial |
|---|---|---|
| Rafael Abreu | BDR | 1010 |
| Isabella Borges | BDR | 2020 |
| Gilvan Brito | Admin | 3030 |

Regras que o servidor aplica sozinho:

- Um BDR só lança e só apaga os próprios dias. O admin mexe em qualquer um.
- Um lançamento por BDR por dia: salvar de novo no mesmo dia corrige o anterior.
- Só o admin troca PINs.
- Dez erros de PIN a partir do mesmo lugar bloqueiam novas tentativas por 10 minutos.
- Sem estar logado não dá para ver nada, nem os números.

## Subir no ar

O repositório já publica sozinho. Você só precisa dar ao GitHub uma chave da
Cloudflare, uma vez, e depois todo push na `main` republica o painel.

**1. Criar o token na Cloudflare**

Vá em [Meu perfil → Tokens de API](https://dash.cloudflare.com/profile/api-tokens),
clique em *Create Token* e escolha o modelo pronto **Edit Cloudflare Workers**.
Ele já vem com as permissões certas (Workers e KV). Copie o token que aparecer —
ele só é mostrado uma vez.

**2. Pegar o id da conta**

No painel da Cloudflare, em *Workers & Pages*, o **Account ID** aparece na
coluna da direita. É uma sequência de letras e números.

**3. Guardar os dois no GitHub**

No repositório, em **Settings → Secrets and variables → Actions → New repository
secret**, crie dois segredos com estes nomes exatos:

| Nome | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | o token do passo 1 |
| `CLOUDFLARE_ACCOUNT_ID` | o id do passo 2 |

Segredo é diferente de arquivo: o valor fica guardado cifrado no GitHub, nunca
aparece no código nem no log. Não coloque esses valores em nenhum arquivo do
repositório.

**4. Publicar**

Vá na aba **Actions → Publicar no Cloudflare → Run workflow**. Ou simplesmente
faça o merge desta branch na `main`, que ele dispara sozinho.

A publicação cria o Worker, cria o lugar onde os lançamentos ficam guardados
(se ainda não existir) e sobe a página. No fim, o passo *Publicar* mostra o
endereço, algo como `https://painelbdr.SEU-USUARIO.workers.dev`.

Rodar de novo é seguro: ele reaproveita o mesmo lugar de armazenamento e nunca
apaga lançamento nenhum.

**5. Trocar os PINs**

Os PINs da tabela acima vieram do painel original e já circularam. Entre como
Gilvan, clique em **Trocar PINs** no fim da página e defina um PIN novo para
cada pessoa antes de divulgar o link.

## Usar o domínio painel.genosgroup.com.br

Quando o domínio `genosgroup.com.br` já estiver na sua conta Cloudflare, abra o
`wrangler.toml`, descomente as três últimas linhas:

```toml
[[routes]]
pattern = "painel.genosgroup.com.br"
custom_domain = true
```

e publique de novo. O Cloudflare cria o registro de DNS sozinho e o painel passa
a responder nesse endereço.

## Publicar do seu computador, se preferir

Não é preciso, mas fica registrado. Com o Node.js instalado, dentro da pasta:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create PAINEL
```

O último comando imprime um `id`. Cole esse id no `wrangler.toml`, no lugar de
`COLE_O_ID_AQUI`, e então:

```bash
npx wrangler deploy
```

## Mexer no painel sem publicar

Para ver as alterações rodando na sua máquina, sem afetar o que está no ar:

```bash
npm install
npm run dev
```

Abre em `http://localhost:8787`. Os dados dessa versão local ficam na pasta
`.wrangler` e não têm nada a ver com os dados do ar.

## Coisas que vale saber

**O link é público.** Qualquer pessoa que descubra o endereço cai na tela de
PIN. O PIN de 4 dígitos mais o bloqueio por tentativas segura o uso normal,
mas não é uma tranca forte. Se quiser fechar de verdade, o caminho é o
Cloudflare Access (grátis até 50 pessoas): ele exige login por e-mail antes de
a página sequer carregar. Dá para ligar depois, sem mexer no código.

**Cópia de segurança.** O navegador de quem lança guarda uma cópia dos
lançamentos. Se um dia o painel abrir vazio, aparece um aviso com o botão
*Restaurar*. Para uma cópia fora do navegador, use **Baixar CSV** na visão do
admin de tempos em tempos.

**Se duas pessoas salvarem no mesmo segundo**, o servidor grava as duas — cada
lançamento é enviado sozinho, não a planilha inteira. Com dois BDRs lançando
uma vez por dia, não é um cenário que preocupe.

**Datas do período.** O calendário de semanas, as metas e os feriados estão no
começo do `<script>` em `public/index.html`, nas constantes `SEMANAS`,
`FERIADOS`, `METAS` e `PRIMEIRA_PARCELA`. Mudou o período ou a regra de
comissão, é ali que se mexe.

## As rotas da API

Só para referência, caso precise integrar com outra coisa depois.

| Rota | O que faz |
|---|---|
| `POST /api/login` | recebe perfil e PIN, devolve o token da sessão |
| `GET /api/estado` | devolve todos os lançamentos do período |
| `GET /api/eu` | diz quem é o dono da sessão |
| `POST /api/lancamento` | grava ou corrige um dia |
| `POST /api/lancamento/excluir` | apaga um lançamento |
| `POST /api/lancamentos/importar` | restaura a cópia guardada no navegador |
| `POST /api/pin` | troca o PIN de alguém (só admin) |
| `POST /api/sair` | encerra a sessão |

Menos o login, todas pedem o cabeçalho `Authorization: Bearer <token>`.
