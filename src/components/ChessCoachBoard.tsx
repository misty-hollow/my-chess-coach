"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Color, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";

type EngineScore =
  | { type: "cp"; value: number }
  | { type: "mate"; value: number };

type CandidateMove = {
  multipv: number;
  depth: number;
  move: string;
  score: EngineScore;
  pv: string[];
};

type AnalysisResult = {
  bestMove: string | null;
  candidates: CandidateMove[];
};

type MoveSquares = {
  from?: Square;
  to?: Square;
  promotion?: string;
};

function getTurnLabel(game: Chess) {
  if (game.isCheckmate()) {
    return `Checkmate. ${game.turn() === "w" ? "Black" : "White"} wins.`;
  }

  if (game.isDraw()) {
    return "Draw.";
  }

  return `${game.turn() === "w" ? "White" : "Black"} to move${
    game.isCheck() ? " - check" : ""
  }`;
}

function parseInfoLine(line: string): CandidateMove | null {
  if (!line.startsWith("info ") || !line.includes(" pv ")) {
    return null;
  }

  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const multipvMatch = line.match(/\bmultipv\s+(\d+)/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);
  const pvMatch = line.match(/\bpv\s+(.+)$/);

  if (!depthMatch || !pvMatch || (!cpMatch && !mateMatch)) {
    return null;
  }

  const pv = pvMatch[1].trim().split(/\s+/);
  const move = pv[0];

  if (!move) {
    return null;
  }

  return {
    multipv: multipvMatch ? Number(multipvMatch[1]) : 1,
    depth: Number(depthMatch[1]),
    move,
    score: cpMatch
      ? { type: "cp", value: Number(cpMatch[1]) }
      : { type: "mate", value: Number(mateMatch?.[1] ?? 0) },
    pv,
  };
}

function parseBestMove(line: string) {
  const bestMove = line.match(/^bestmove\s+(\S+)/)?.[1] ?? null;

  if (!bestMove || bestMove === "(none)") {
    return null;
  }

  return bestMove;
}

function parseUciMove(move: string): MoveSquares {
  const uciMoveMatch = move.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);

  if (!uciMoveMatch) {
    return {};
  }

  return {
    from: uciMoveMatch[1] as Square,
    to: uciMoveMatch[2] as Square,
    promotion: uciMoveMatch[3],
  };
}

function formatMove(game: Chess, move: string) {
  const { from, to, promotion } = parseUciMove(move);

  if (!from || !to) {
    return move;
  }

  const clone = new Chess(game.fen());
  const playedMove = clone.move({
    from,
    to,
    promotion: promotion || "q",
  });

  return playedMove ? `${playedMove.san} (${move})` : move;
}

function formatScore(score: EngineScore, turn: Color) {
  if (score.type === "mate") {
    const winner =
      (score.value > 0 && turn === "w") || (score.value < 0 && turn === "b")
        ? "White"
        : "Black";

    return `${winner} mate in ${Math.abs(score.value)}`;
  }

  const whiteCentipawns = turn === "w" ? score.value : -score.value;
  const pawns = whiteCentipawns / 100;

  return `White ${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

export function ChessCoachBoard() {
  const [game, setGame] = useState(() => new Chess());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult>({
    bestMove: null,
    candidates: [],
  });
  const [engineLogs, setEngineLogs] = useState<string[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const analysisTimeoutRef = useRef<number | null>(null);

  const turnLabel = useMemo(() => getTurnLabel(game), [game]);
  const canUndo = game.history().length > 0;
  const primaryCandidate = analysis.candidates[0];
  const bestMoveSquares = analysis.bestMove
    ? parseUciMove(analysis.bestMove)
    : {};
  const bestMoveArrows =
    bestMoveSquares.from && bestMoveSquares.to
      ? [
          {
            startSquare: bestMoveSquares.from,
            endSquare: bestMoveSquares.to,
            color: "rgba(250, 204, 21, 0.82)",
          },
        ]
      : [];
  const squareStyles =
    bestMoveSquares.from && bestMoveSquares.to
      ? {
          [bestMoveSquares.from]: {
            backgroundColor: "rgba(250, 204, 21, 0.72)",
            boxShadow: "inset 0 0 0 4px rgba(120, 53, 15, 0.55)",
          },
          [bestMoveSquares.to]: {
            background:
              "radial-gradient(circle, rgba(250, 204, 21, 0.88) 34%, rgba(250, 204, 21, 0.42) 36%, rgba(250, 204, 21, 0.42) 100%)",
          },
        }
      : undefined;

  useEffect(() => {
    return () => {
      if (analysisTimeoutRef.current) {
        window.clearTimeout(analysisTimeoutRef.current);
      }
      workerRef.current?.terminate();
    };
  }, []);

  function stopCurrentAnalysis() {
    if (analysisTimeoutRef.current) {
      window.clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    setIsAnalyzing(false);
  }

  function handlePieceDrop({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }) {
    if (!targetSquare) {
      return false;
    }

    const nextGame = new Chess(game.fen());
    const move = nextGame.move({
      from: sourceSquare as Square,
      to: targetSquare as Square,
      promotion: "q",
    });

    if (!move) {
      return false;
    }

    stopCurrentAnalysis();
    setGame(nextGame);
    setAnalysis({ bestMove: null, candidates: [] });
    setAnalysisError(null);
    setEngineLogs([]);
    return true;
  }

  function handleUndo() {
    stopCurrentAnalysis();
    const nextGame = new Chess(game.fen());
    nextGame.undo();
    setGame(nextGame);
    setAnalysis({ bestMove: null, candidates: [] });
    setAnalysisError(null);
    setEngineLogs([]);
  }

  function handleReset() {
    stopCurrentAnalysis();
    setGame(new Chess());
    setAnalysis({ bestMove: null, candidates: [] });
    setAnalysisError(null);
    setEngineLogs([]);
  }

  function handleAnalyze() {
    workerRef.current?.terminate();
    if (analysisTimeoutRef.current) {
      window.clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }

    const worker = new Worker("/stockfish/stockfish-18-lite-single.js");
    const candidates = new Map<number, CandidateMove>();

    workerRef.current = worker;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setEngineLogs([]);
    setAnalysis({ bestMove: null, candidates: [] });

    analysisTimeoutRef.current = window.setTimeout(() => {
      if (workerRef.current !== worker) {
        return;
      }

      setAnalysisError(
        "Stockfish did not finish in time. Try Analyze again or make a move and re-run analysis.",
      );
      setIsAnalyzing(false);
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
    }, 20000);

    worker.onmessage = (event: MessageEvent<string>) => {
      if (workerRef.current !== worker) {
        return;
      }

      const line = String(event.data);
      setEngineLogs((currentLogs) => [...currentLogs, line]);

      const candidate = parseInfoLine(line);
      if (candidate) {
        const currentCandidate = candidates.get(candidate.multipv);
        if (!currentCandidate || candidate.depth >= currentCandidate.depth) {
          candidates.set(candidate.multipv, candidate);
          setAnalysis((currentAnalysis) => ({
            ...currentAnalysis,
            candidates: Array.from(candidates.values())
              .sort((a, b) => a.multipv - b.multipv)
              .slice(0, 3),
          }));
        }
      }

      const bestMove = parseBestMove(line);
      if (bestMove) {
        if (analysisTimeoutRef.current) {
          window.clearTimeout(analysisTimeoutRef.current);
          analysisTimeoutRef.current = null;
        }
        setAnalysis({
          bestMove,
          candidates: Array.from(candidates.values())
            .sort((a, b) => a.multipv - b.multipv)
            .slice(0, 3),
        });
        setIsAnalyzing(false);
        worker.terminate();
        workerRef.current = null;
      } else if (line.startsWith("bestmove ")) {
        if (analysisTimeoutRef.current) {
          window.clearTimeout(analysisTimeoutRef.current);
          analysisTimeoutRef.current = null;
        }
        setAnalysisError(
          "Stockfish did not find a legal best move for this position.",
        );
        setIsAnalyzing(false);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.onerror = () => {
      if (workerRef.current !== worker) {
        return;
      }

      if (analysisTimeoutRef.current) {
        window.clearTimeout(analysisTimeoutRef.current);
        analysisTimeoutRef.current = null;
      }
      setEngineLogs((currentLogs) => [
        ...currentLogs,
        "Engine error: Stockfish worker failed to load or run.",
      ]);
      setAnalysisError(
        "Stockfish could not start in this browser session. Refresh the page and try again.",
      );
      setIsAnalyzing(false);
      worker.terminate();
      workerRef.current = null;
    };

    worker.postMessage("uci");
    worker.postMessage("setoption name MultiPV value 3");
    worker.postMessage("isready");
    worker.postMessage(`position fen ${game.fen()}`);
    worker.postMessage("go depth 12");
  }

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
            Board
          </p>
          <p className="mt-1 text-lg font-semibold text-stone-950">
            {turnLabel}
          </p>
        </div>

        <div className="flex gap-3">
          <button
            className="h-11 rounded-md border border-stone-300 px-4 text-sm font-semibold text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
          >
            Undo
          </button>
          <button
            className="h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-70"
            type="button"
            onClick={handleAnalyze}
            disabled={isAnalyzing}
          >
            {isAnalyzing ? "Analyzing..." : "Analyze"}
          </button>
          <button
            className="h-11 rounded-md bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800"
            type="button"
            onClick={handleReset}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="aspect-square w-full overflow-hidden rounded-lg border border-stone-300 shadow-2xl shadow-stone-300/50">
        <Chessboard
          options={{
            id: "my-chess-coach-board",
            position: game.fen(),
            allowDragOffBoard: false,
            animationDurationInMs: 180,
            boardStyle: {
              width: "100%",
              height: "100%",
            },
            darkSquareStyle: { backgroundColor: "#166534" },
            lightSquareStyle: { backgroundColor: "#f5f5f4" },
            squareStyles,
            arrows: bestMoveArrows,
            allowDrawingArrows: false,
            onPieceDrop: handlePieceDrop,
            canDragPiece: ({ piece }) => {
              const pieceColor = piece.pieceType[0];
              return pieceColor === game.turn();
            },
          }}
        />
      </div>

      <section className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-stone-950">Analysis</h2>
          {isAnalyzing ? (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-800">
              Stockfish is thinking
            </span>
          ) : null}
        </div>

        {analysisError ? (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium leading-6 text-red-800">
            {analysisError}
          </div>
        ) : null}

        {isAnalyzing ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium leading-6 text-emerald-900">
            Analyzing the current board position. Candidate moves will appear
            as the engine searches.
          </div>
        ) : null}

        {analysis.bestMove || analysis.candidates.length ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
                Best move
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-950">
                {analysis.bestMove ? formatMove(game, analysis.bestMove) : "-"}
              </p>
              {bestMoveSquares.from && bestMoveSquares.to ? (
                <p className="mt-2 text-sm font-medium text-amber-900">
                  Highlighted from {bestMoveSquares.from} to {bestMoveSquares.to}
                </p>
              ) : null}
            </div>

            {primaryCandidate ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Evaluation score
                  </p>
                  <p className="mt-1 font-semibold text-stone-950">
                    {formatScore(primaryCandidate.score, game.turn())}
                  </p>
                </div>
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Principal variation
                  </p>
                  <p className="mt-1 text-sm leading-6 text-stone-700">
                    {primaryCandidate.pv.join(" ")}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3">
              {analysis.candidates.map((candidate) => (
                <div
                  className="rounded-md border border-stone-200 bg-stone-50 p-3 transition hover:border-stone-300"
                  key={`${candidate.multipv}-${candidate.move}`}
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <p className="font-semibold text-stone-950">
                      {candidate.multipv}. {formatMove(game, candidate.move)}
                    </p>
                    <p className="text-sm font-medium text-stone-700">
                      {formatScore(candidate.score, game.turn())}
                    </p>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    PV: {candidate.pv.join(" ")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm leading-6 text-stone-600">
            Click Analyze to evaluate the current board position.
          </p>
        )}

        <details className="mt-4 border-t border-stone-200 pt-4">
          <summary className="cursor-pointer text-sm font-semibold text-stone-700">
            Engine debug logs
          </summary>
          <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-stone-950 p-3 text-xs leading-5 text-stone-100">
            {engineLogs.length
              ? engineLogs.join("\n")
              : "No engine output yet."}
          </pre>
        </details>
      </section>
    </div>
  );
}
