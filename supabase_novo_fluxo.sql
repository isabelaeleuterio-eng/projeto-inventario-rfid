-- ============================================================
-- INVENTÁRIO RFID - AJUSTE DO BANCO PARA O FLUXO NOVO (SEM BOX)
-- Rode UMA vez no Supabase: SQL Editor > New query > Run.
-- NÃO apaga funcionários, equipamentos nem empréstimos reais.
-- Pode rodar de novo sem problema.
-- ============================================================

BEGIN;

-- 1) Colunas que o sistema usa
ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE funcionarios ADD COLUMN IF NOT EXISTS setor TEXT;
ALTER TABLE equipamentos ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE equipamentos ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE emprestimos  ADD COLUMN IF NOT EXISTS status TEXT;

-- 2) Sem box: a coluna deixa de ser obrigatória e de ser única
ALTER TABLE equipamentos ALTER COLUMN box_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_equipamentos_box_unico;
DROP INDEX IF EXISTS idx_equipamentos_box_unica;

-- 3) Remove regras antigas de status (eram a causa de empréstimos recusados)
DROP TRIGGER IF EXISTS trigger_normalizar_status_emprestimo ON emprestimos;
DROP FUNCTION IF EXISTS normalizar_status_emprestimo();
ALTER TABLE emprestimos DROP CONSTRAINT IF EXISTS emprestimos_status_check;

-- 4) Remove seleções "pendentes" abandonadas do fluxo antigo (não são empréstimos)
DELETE FROM emprestimos
WHERE data_devolucao IS NULL
  AND LOWER(TRIM(COALESCE(status, ''))) LIKE 'pendente%';

-- 5) Padroniza o texto do status: quem manda é a data de devolução
UPDATE emprestimos
SET status = CASE WHEN data_devolucao IS NULL THEN 'Emprestado' ELSE 'Devolvido' END;

ALTER TABLE emprestimos ALTER COLUMN status SET DEFAULT 'Emprestado';

ALTER TABLE emprestimos
ADD CONSTRAINT emprestimos_status_check CHECK (status IN ('Emprestado', 'Devolvido'));

-- 6) Status dos equipamentos de acordo com os empréstimos em aberto
UPDATE equipamentos e
SET status = CASE
    WHEN EXISTS (SELECT 1 FROM emprestimos m WHERE m.equipamento_id = e.id AND m.data_devolucao IS NULL)
        THEN 'emprestado'
    ELSE 'disponivel'
END
WHERE e.status <> 'manutencao';

-- 7) No máximo 1 empréstimo em aberto por equipamento e por funcionário
DROP INDEX IF EXISTS idx_emprestimo_equipamento_ativo;
DROP INDEX IF EXISTS idx_emprestimo_funcionario_ativo;

CREATE UNIQUE INDEX IF NOT EXISTS idx_emprestimo_equipamento_aberto
ON emprestimos (equipamento_id) WHERE data_devolucao IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_emprestimo_funcionario_aberto
ON emprestimos (funcionario_id) WHERE data_devolucao IS NULL;

COMMIT;

-- ============================================================
-- CONFERÊNCIA (deve listar sem erro)
-- ============================================================
SELECT e.id, f.nome AS funcionario, q.nome AS equipamento, e.status, e.data_retirada, e.data_devolucao
FROM emprestimos e
JOIN funcionarios f ON f.id = e.funcionario_id
JOIN equipamentos q ON q.id = e.equipamento_id
ORDER BY e.id DESC;
