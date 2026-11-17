"""Testes do criar_criterio.py contra uma API em memória.  python3 -m unittest discover -s scripts"""
import copy
import json
import unittest
from pathlib import Path

import criar_criterio as cc

EXEMPLO = json.loads((Path(__file__).parent / "criterio.exemplo.json").read_text(encoding="utf-8"))


class ApiFalsa(cc.Api):
    """Guarda critérios e subcritérios em memória. A listagem de critérios pagina de 2 em 2."""

    def __init__(self, criterios=()):
        super().__init__("https://avaliacao.exemplo.com/api/v1", "token")
        self.criterios = [dict(c) for c in criterios]
        self.subs = []
        self.posts = []

    def req(self, metodo, caminho, corpo=None):
        caminho = caminho.replace(self.url, "")
        if metodo == "POST":
            self.posts.append((caminho, corpo))
            if caminho == "/companies/criteria":
                novo = {"id": 100 + len(self.criterios), **corpo}
                self.criterios.append(novo)
                return {"data": novo}
            if caminho == "/companies/sub-criteria":
                novo = {"id": 500 + len(self.subs), **corpo}
                self.subs.append(novo)
                return {"data": novo}
        if caminho.startswith("/companies/criteria?page=") or caminho == "/companies/criteria":
            pagina = int(caminho.split("=")[1]) if "=" in caminho else 1
            fatia = self.criterios[(pagina - 1) * 2: pagina * 2]
            mais = pagina * 2 < len(self.criterios)
            return {"data": {"data": fatia, "next_page_url":
                             f"{self.url}/companies/criteria?page={pagina + 1}" if mais else None}}
        if caminho.endswith("/sub-criteria"):
            cid = int(caminho.split("/")[3])
            return {"data": [s for s in self.subs if s["criteria_id"] == cid]}
        raise AssertionError(f"rota inesperada: {metodo} {caminho}")


def silencio(*_):
    pass


class TestCriarCriterio(unittest.TestCase):
    def test_exemplo_e_valido(self):
        self.assertEqual(cc.validar(EXEMPLO), [])

    def test_simulacao_nao_envia_nada(self):
        api = ApiFalsa()
        self.assertIsNone(cc.sincronizar(api, EXEMPLO, criar=False, log=silencio))
        self.assertEqual(api.posts, [])

    def test_cria_criterio_e_subcriterios(self):
        api = ApiFalsa()
        cid = cc.sincronizar(api, EXEMPLO, criar=True, log=silencio)
        self.assertEqual([c["name"] for c in api.criterios], ["Atendimento receptivo"])
        self.assertEqual(len(api.subs), len(EXEMPLO["subcriterios"]))
        self.assertTrue(all(s["criteria_id"] == cid for s in api.subs))

    def test_rodar_de_novo_nao_duplica(self):
        api = ApiFalsa()
        cc.sincronizar(api, EXEMPLO, criar=True, log=silencio)
        antes = len(api.posts)
        cc.sincronizar(api, EXEMPLO, criar=True, log=silencio)
        self.assertEqual(len(api.posts), antes)

    def test_subcriterio_novo_no_json_cria_so_ele(self):
        api = ApiFalsa()
        cc.sincronizar(api, EXEMPLO, criar=True, log=silencio)
        maior = copy.deepcopy(EXEMPLO)
        maior["subcriterios"].append({**maior["subcriterios"][0], "nome": "Tom de voz"})
        antes = len(api.posts)
        cc.sincronizar(api, maior, criar=True, log=silencio)
        self.assertEqual([p[1]["name"] for p in api.posts[antes:]], ["Tom de voz"])

    def test_acha_o_criterio_na_segunda_pagina(self):
        outros = [{"id": i, "name": f"Outro {i}", "type": "calls"} for i in range(1, 4)]
        api = ApiFalsa(outros + [{"id": 9, "name": "Atendimento receptivo", "type": "calls"}])
        self.assertEqual(cc.sincronizar(api, EXEMPLO, criar=True, log=silencio), 9)
        self.assertFalse(any(p[0] == "/companies/criteria" for p in api.posts))

    def test_mesmo_nome_em_outro_tipo_nao_conta(self):
        api = ApiFalsa([{"id": 1, "name": "Atendimento receptivo", "type": "whatsapp"}])
        self.assertNotEqual(cc.sincronizar(api, EXEMPLO, criar=True, log=silencio), 1)

    def test_frase_ideal_longa_e_barrada_antes_de_qualquer_post(self):
        ruim = copy.deepcopy(EXEMPLO)
        ruim["subcriterios"][-1]["frases_ideais"] = ["x" * 300]
        erros = cc.validar(ruim)
        self.assertEqual(len(erros), 1)
        self.assertIn("máx. 255", erros[0])

    def test_o_que_avaliar_vai_na_descricao(self):
        corpo = cc.corpo_subcriterio(EXEMPLO["subcriterios"][0], 7)
        self.assertIn("O que avaliar: Saudação adequada ao período; Nome do agente", corpo["description"])
        self.assertLessEqual(len(corpo["ideal_phrase"]), 255)

    def test_env_com_aspas_e_comentario(self):
        caminho = Path(__file__).parent / "_teste.env"
        caminho.write_text('A="com espaço"\nB=valor  # comentário\n# C=x\n', encoding="utf-8")
        try:
            self.assertEqual(cc.carregar_env(caminho), {"A": "com espaço", "B": "valor"})
        finally:
            caminho.unlink()


if __name__ == "__main__":
    unittest.main()
