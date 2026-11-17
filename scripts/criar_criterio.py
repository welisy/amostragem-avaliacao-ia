#!/usr/bin/env python3
"""Cria na API de avaliação um critério e os subcritérios dele, a partir de um JSON.

    python3 scripts/criar_criterio.py scripts/criterio.exemplo.json           # simula: mostra o que faria
    python3 scripts/criar_criterio.py scripts/criterio.exemplo.json --criar   # cria

Idempotente: o critério é procurado pelo nome e pelo tipo, e o subcritério que já existe (mesmo nome) é
pulado. Depois de acrescentar um subcritério no JSON, rodar de novo cria só o que falta.

Configuração (no ambiente ou num .env na raiz do repositório):
    AVALIACAO_API_URL     ex.: https://avaliacao.exemplo.com/api/v1
    AVALIACAO_API_TOKEN   vai no header api_token
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

LIMITE_FRASE_IDEAL = 255      # a API recusa ideal_phrase maior no POST; a description não tem limite


# --------------------------------------------------------------------------- configuração
def carregar_env(caminho):
    """Lê KEY=valor de um .env simples (aspas e comentário no fim da linha são aceitos)."""
    valores = {}
    if not caminho.exists():
        return valores
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        valor = valor.strip()
        if valor[:1] in "\"'" and valor.endswith(valor[0]) and len(valor) > 1:
            valor = valor[1:-1]
        elif " #" in valor:
            valor = valor.split(" #", 1)[0].strip()
        valores[chave.strip()] = valor
    return valores


# --------------------------------------------------------------------------- conteúdo
def frase_ideal(sc):
    return ";\n".join(sc["frases_ideais"]) + ";"


def validar(criterio):
    """Devolve a lista de problemas. Tudo é conferido antes do primeiro POST: nada fica pela metade."""
    erros = []
    if not str(criterio.get("nome", "")).strip():
        erros.append("o critério precisa de nome")
    if criterio.get("tipo") not in ("calls", "whatsapp"):
        erros.append('tipo deve ser "calls" ou "whatsapp"')
    subs = criterio.get("subcriterios") or []
    if not subs:
        erros.append("nenhum subcritério")
    nomes = [s.get("nome", "") for s in subs]
    for nome in {n for n in nomes if nomes.count(n) > 1}:
        erros.append(f'subcritério repetido: "{nome}"')
    for sc in subs:
        for campo in ("nome", "cor", "descricao", "avaliar", "frases_ideais"):
            if not sc.get(campo):
                erros.append(f'"{sc.get("nome", "?")}": falta {campo}')
        if sc.get("frases_ideais") and len(frase_ideal(sc)) > LIMITE_FRASE_IDEAL:
            erros.append(f'"{sc["nome"]}": frases_ideais com {len(frase_ideal(sc))} caracteres '
                         f"(máx. {LIMITE_FRASE_IDEAL}); mova parte para \"avaliar\"")
    return erros


def corpo_subcriterio(sc, criteria_id):
    # "O que avaliar" vai na description, que não tem limite de tamanho.
    descricao = f'{sc["descricao"]} O que avaliar: {"; ".join(sc["avaliar"])}.'
    return {"name": sc["nome"], "keyword": None, "description": descricao, "color": sc["cor"],
            "ideal_phrase": frase_ideal(sc), "criteria_id": criteria_id}


# --------------------------------------------------------------------------- API
class Api:
    def __init__(self, url, token, timeout=30):
        self.url, self.token, self.timeout = url.rstrip("/"), token, timeout

    def req(self, metodo, caminho, corpo=None):
        url = caminho if caminho.startswith("http") else self.url + caminho
        dados = json.dumps(corpo).encode() if corpo is not None else None
        pedido = urllib.request.Request(url, data=dados, method=metodo, headers={
            "api_token": self.token, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(pedido, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"HTTP {e.code} em {metodo} {caminho}: {e.read()[:500].decode('utf-8', 'replace')}")

    def lista(self, caminho):
        """GET de listagem. Aceita lista pura, {data: [...]} e a paginação {data: {data, next_page_url}}."""
        itens, proxima = [], caminho
        while proxima:
            corpo = self.req("GET", proxima)
            dados = corpo.get("data", corpo) if isinstance(corpo, dict) else corpo
            if isinstance(dados, dict):
                itens += dados.get("data", [])
                proxima = dados.get("next_page_url")
            else:
                itens += dados
                proxima = None
        return itens


def sincronizar(api, criterio, criar=False, log=print):
    """Cria o que falta. Devolve o criteria_id (None na simulação de um critério novo)."""
    existente = next((c for c in api.lista("/companies/criteria")
                      if c["name"] == criterio["nome"] and c["type"] == criterio["tipo"]), None)
    if existente:
        cid = existente["id"]
        log(f'Critério já existe: {criterio["nome"]} (id {cid})')
        ja_existem = {s["name"] for s in api.lista(f"/companies/criteria/{cid}/sub-criteria")}
    elif criar:
        resp = api.req("POST", "/companies/criteria", {"name": criterio["nome"], "type": criterio["tipo"]})
        cid = (resp.get("data") or resp)["id"]
        log(f'Critério criado: {criterio["nome"]} (id {cid})')
        ja_existem = set()
    else:
        cid, ja_existem = None, set()
        log(f'[simulação] criaria o critério: {criterio["nome"]} ({criterio["tipo"]})')

    for sc in criterio["subcriterios"]:
        if sc["nome"] in ja_existem:
            log(f'  = {sc["nome"]} (já existe)')
            continue
        corpo = corpo_subcriterio(sc, cid)
        if criar:
            resp = api.req("POST", "/companies/sub-criteria", corpo)
            log(f'  + {sc["nome"]} (id {(resp.get("data") or resp).get("id")})')
        else:
            log(f'  [simulação] + {sc["nome"]} | frase ideal {len(corpo["ideal_phrase"])} car. '
                f'| descrição {len(corpo["description"])} car.')
    return cid


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    criterio = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    erros = validar(criterio)
    if erros:
        raise SystemExit("Corrija o JSON antes de enviar:\n- " + "\n- ".join(erros))

    env = {**carregar_env(Path(__file__).resolve().parent.parent / ".env"), **os.environ}
    url, token = env.get("AVALIACAO_API_URL", ""), env.get("AVALIACAO_API_TOKEN", "")
    if not url or not token:
        raise SystemExit("Defina AVALIACAO_API_URL e AVALIACAO_API_TOKEN (ambiente ou .env).")

    cid = sincronizar(Api(url, token), criterio, criar="--criar" in argv)
    if cid:
        print(f"\ncriteriaId para o nó Config do workflow: {cid}")


if __name__ == "__main__":
    main(sys.argv[1:])
