"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import type { CSSProperties } from "react";
import {
  selectRecommendedMove,
  type AnalysisMode,
  type CandidateMove,
  type EngineScore,
} from "@/lib/analysisRecommendations";

type AnalysisResult = {
  bestMove: string | null;
  candidates: CandidateMove[];
  mode: AnalysisMode | null;
  recommendedMove: string | null;
  evaluationLoss: number | null;
  usedFallback: boolean;
};

type MoveSquares = {
  from?: Square;
  to?: Square;
  promotion?: string;
};

type BoardOrientation = "white" | "black";

type LegalMoveTarget = {
  square: Square;
  isCapture: boolean;
};

const emptyAnalysis: AnalysisResult = {
  bestMove: null,
  candidates: [],
  mode: null,
  recommendedMove: null,
  evaluationLoss: null,
  usedFallback: false,
};

const analysisModeDetails: Record<
  AnalysisMode,
  { label: string; description: string }
> = {
  best: {
    label: "Best",
    description: "Shows the engine's top recommendation.",
  },
  practical: {
    label: "Practical",
    description: "Suggests a strong, natural move for study.",
  },
  training: {
    label: "Training",
    description: "Shows a reasonable move that keeps the position playable.",
  },
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

function cloneGameWithHistory(game: Chess) {
  const clone = new Chess();
  const pgn = game.pgn();

  if (pgn) {
    clone.loadPgn(pgn);
  }

  return clone;
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

function formatSideToMoveScore(score: EngineScore) {
  if (score.type === "mate") {
    return score.value > 0
      ? `Mate in ${Math.abs(score.value)}`
      : `Losing mate in ${Math.abs(score.value)}`;
  }

  return `${score.value >= 0 ? "+" : ""}${(score.value / 100).toFixed(2)}`;
}

function formatEvaluationLoss(loss: number | null) {
  if (loss === null) {
    return "-";
  }

  if (loss >= 9000) {
    return "large";
  }

  return `${(loss / 100).toFixed(2)} pawns`;
}

function mergeSquareStyle(
  styles: Record<string, CSSProperties>,
  square: Square,
  style: CSSProperties,
) {
  styles[square] = {
    ...(styles[square] ?? {}),
    ...style,
    boxShadow: [styles[square]?.boxShadow, style.boxShadow]
      .filter(Boolean)
      .join(", "),
  };
}

export function ChessCoachBoard() {
  const [game, setGame] = useState(() => new Chess());
  const [boardOrientation, setBoardOrientation] =
    useState<BoardOrientation>("white");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("practical");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult>(emptyAnalysis);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalMoveTargets, setLegalMoveTargets] = useState<LegalMoveTarget[]>(
    [],
  );
  const [engineLogs, setEngineLogs] = useState<string[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const analysisTimeoutRef = useRef<number | null>(null);
  const analysisRequestIdRef = useRef(0);

  const turnLabel = useMemo(() => getTurnLabel(game), [game]);
  const canUndo = game.history().length > 0;
  const analysisModeForResult = analysis.mode ?? analysisMode;
  const selectedModeDetails = analysisModeDetails[analysisModeForResult];
  const recommendedCandidate =
    analysis.candidates.find(
      (candidate) => candidate.move === analysis.recommendedMove,
    ) ?? null;
  const primaryCandidate = analysis.candidates[0];
  const highlightedMove = analysis.recommendedMove ?? analysis.bestMove;
  const highlightedMoveSquares = highlightedMove
    ? parseUciMove(highlightedMove)
    : {};
  const bestMoveArrows =
    highlightedMoveSquares.from && highlightedMoveSquares.to
      ? [
          {
            startSquare: highlightedMoveSquares.from,
            endSquare: highlightedMoveSquares.to,
            color: "rgba(250, 204, 21, 0.82)",
          },
        ]
      : [];
  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};

    if (highlightedMoveSquares.from && highlightedMoveSquares.to) {
      mergeSquareStyle(styles, highlightedMoveSquares.from, {
        backgroundColor: "rgba(250, 204, 21, 0.72)",
        boxShadow: "inset 0 0 0 4px rgba(120, 53, 15, 0.55)",
      });
      mergeSquareStyle(styles, highlightedMoveSquares.to, {
        backgroundColor: "rgba(250, 204, 21, 0.48)",
        backgroundImage:
          "radial-gradient(circle, rgba(250, 204, 21, 0.88) 34%, transparent 36%)",
      });
    }

    if (selectedSquare) {
      mergeSquareStyle(styles, selectedSquare, {
        backgroundColor: "rgba(96, 165, 250, 0.36)",
        boxShadow: "inset 0 0 0 3px rgba(255, 255, 255, 0.55)",
      });
    }

    for (const target of legalMoveTargets) {
      mergeSquareStyle(
        styles,
        target.square,
        target.isCapture
          ? {
              boxShadow:
                "inset 0 0 0 4px rgba(255, 255, 255, 0.88), inset 0 0 0 6px rgba(0, 0, 0, 0.28)",
            }
          : {
              backgroundImage:
                "radial-gradient(circle, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0.96) 18%, rgba(0, 0, 0, 0.34) 19%, transparent 22%)",
            },
      );
    }

    return Object.keys(styles).length ? styles : undefined;
  }, [
    highlightedMoveSquares.from,
    highlightedMoveSquares.to,
    legalMoveTargets,
    selectedSquare,
  ]);
  const isRecommendationDifferentFromTop =
    recommendedCandidate && primaryCandidate
      ? recommendedCandidate.move !== primaryCandidate.move
      : false;

  useEffect(() => {
    return () => {
      if (analysisTimeoutRef.current) {
        window.clearTimeout(analysisTimeoutRef.current);
      }
      workerRef.current?.terminate();
    };
  }, []);

  function stopCurrentAnalysis() {
    analysisRequestIdRef.current += 1;

    if (analysisTimeoutRef.current) {
      window.clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    setIsAnalyzing(false);
  }

  function clearBoardGuidance() {
    setSelectedSquare(null);
    setLegalMoveTargets([]);
    setAnalysis(emptyAnalysis);
    setAnalysisError(null);
    setEngineLogs([]);
  }

  function getLegalMoveTargets(square: Square) {
    return game
      .moves({ square, verbose: true })
      .map((move) => ({
        square: move.to as Square,
        isCapture: Boolean(move.captured),
      }));
  }

  function isOwnPiece(square: Square) {
    const piece = game.get(square);
    return Boolean(piece && piece.color === game.turn());
  }

  function makeMove(sourceSquare: Square, targetSquare: Square) {
    const nextGame = cloneGameWithHistory(game);
    const move = nextGame.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (!move) {
      return false;
    }

    stopCurrentAnalysis();
    setGame(nextGame);
    clearBoardGuidance();
    return true;
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

    return makeMove(sourceSquare as Square, targetSquare as Square);
  }

  function handleSquareClick({ square }: { square: string }) {
    const clickedSquare = square as Square;

    if (selectedSquare) {
      const selectedLegalMove = legalMoveTargets.some(
        (target) => target.square === clickedSquare,
      );

      if (selectedLegalMove && makeMove(selectedSquare, clickedSquare)) {
        return;
      }
    }

    if (isOwnPiece(clickedSquare)) {
      setSelectedSquare(clickedSquare);
      setLegalMoveTargets(getLegalMoveTargets(clickedSquare));
      return;
    }

    setSelectedSquare(null);
    setLegalMoveTargets([]);
  }

  function handleUndo() {
    stopCurrentAnalysis();
    setGame((currentGame) => {
      const nextGame = cloneGameWithHistory(currentGame);
      nextGame.undo();
      return nextGame;
    });
    clearBoardGuidance();
  }

  function handleReset() {
    stopCurrentAnalysis();
    setGame(new Chess());
    clearBoardGuidance();
  }

  function handleFlipBoard() {
    setBoardOrientation((currentOrientation) =>
      currentOrientation === "white" ? "black" : "white",
    );
  }

  function handleAnalyze() {
    workerRef.current?.terminate();
    if (analysisTimeoutRef.current) {
      window.clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }

    const requestId = analysisRequestIdRef.current + 1;
    analysisRequestIdRef.current = requestId;
    const modeForRequest = analysisMode;
    const worker = new Worker("/stockfish/stockfish-18-lite-single.js");
    const candidates = new Map<number, CandidateMove>();
    const engineLogBuffer: string[] = [];

    workerRef.current = worker;
    setIsAnalyzing(true);
    clearBoardGuidance();

    analysisTimeoutRef.current = window.setTimeout(() => {
      if (
        workerRef.current !== worker ||
        analysisRequestIdRef.current !== requestId
      ) {
        return;
      }

      setEngineLogs(engineLogBuffer);
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
      if (
        workerRef.current !== worker ||
        analysisRequestIdRef.current !== requestId
      ) {
        return;
      }

      const line = String(event.data);
      engineLogBuffer.push(line);

      const candidate = parseInfoLine(line);
      if (candidate) {
        const currentCandidate = candidates.get(candidate.multipv);
        if (!currentCandidate || candidate.depth >= currentCandidate.depth) {
          candidates.set(candidate.multipv, candidate);
        }
      }

      const bestMove = parseBestMove(line);
      if (bestMove) {
        if (analysisTimeoutRef.current) {
          window.clearTimeout(analysisTimeoutRef.current);
          analysisTimeoutRef.current = null;
        }
        const finalCandidates = Array.from(candidates.values())
          .sort((a, b) => a.multipv - b.multipv)
          .slice(0, 6);
        const recommendation = selectRecommendedMove(
          finalCandidates,
          modeForRequest,
        );

        setAnalysis({
          bestMove,
          candidates: finalCandidates,
          mode: modeForRequest,
          recommendedMove: recommendation.candidate?.move ?? bestMove,
          evaluationLoss: recommendation.evaluationLoss,
          usedFallback: recommendation.usedFallback,
        });
        setEngineLogs(engineLogBuffer);
        setIsAnalyzing(false);
        worker.terminate();
        workerRef.current = null;
      } else if (line.startsWith("bestmove ")) {
        if (analysisTimeoutRef.current) {
          window.clearTimeout(analysisTimeoutRef.current);
          analysisTimeoutRef.current = null;
        }
        setEngineLogs(engineLogBuffer);
        setAnalysisError(
          "Stockfish did not find a legal best move for this position.",
        );
        setIsAnalyzing(false);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.onerror = () => {
      if (
        workerRef.current !== worker ||
        analysisRequestIdRef.current !== requestId
      ) {
        return;
      }

      if (analysisTimeoutRef.current) {
        window.clearTimeout(analysisTimeoutRef.current);
        analysisTimeoutRef.current = null;
      }
      setEngineLogs([
        ...engineLogBuffer,
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
    worker.postMessage("setoption name MultiPV value 6");
    worker.postMessage("isready");
    worker.postMessage(`position fen ${game.fen()}`);
    worker.postMessage("go depth 12");
  }

  return (
    <div className="w-full">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base font-semibold text-stone-950">{turnLabel}</p>

        <div className="flex flex-col gap-2 sm:items-end">
          <label className="flex items-center gap-2 text-sm font-semibold text-stone-800">
            Analysis Mode
            <select
              className="h-10 rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold text-stone-950 outline-none transition focus:border-emerald-700"
              value={analysisMode}
              onChange={(event) =>
                setAnalysisMode(event.target.value as AnalysisMode)
              }
            >
              {Object.entries(analysisModeDetails).map(([mode, details]) => (
                <option value={mode} key={mode}>
                  {details.label}
                </option>
              ))}
            </select>
          </label>
          <p className="max-w-xs text-right text-xs leading-5 text-stone-600">
            Practical mode favors strong, natural candidate moves for study.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 sm:justify-end">
          <button
            className="h-10 rounded-md border border-stone-300 px-3 text-sm font-semibold text-stone-800 transition hover:border-stone-500 hover:bg-stone-100"
            type="button"
            onClick={handleFlipBoard}
            aria-pressed={boardOrientation === "black"}
          >
            Flip Board
          </button>
          <button
            className="h-10 rounded-md border border-stone-300 px-3 text-sm font-semibold text-stone-800 transition hover:border-stone-500 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
          >
            Undo
          </button>
          <button
            className="h-10 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-70"
            type="button"
            onClick={handleAnalyze}
            disabled={isAnalyzing}
          >
            {isAnalyzing ? "Analyzing..." : "Analyze"}
          </button>
          <button
            className="h-10 rounded-md bg-stone-950 px-3 text-sm font-semibold text-white transition hover:bg-stone-800"
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
            boardOrientation,
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
            onSquareClick: handleSquareClick,
            canDragPiece: ({ piece }) => {
              const pieceColor = piece.pieceType[0];
              return pieceColor === game.turn();
            },
          }}
        />
      </div>

      <section className="mt-4 rounded-lg border border-stone-200 bg-white p-4">
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
            Analyzing the current board position. Results will appear when the
            search finishes.
          </div>
        ) : null}

        {analysis.bestMove || analysis.candidates.length ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
                    Recommended move
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-950">
                    {recommendedCandidate
                      ? formatMove(game, recommendedCandidate.move)
                      : analysis.bestMove
                        ? formatMove(game, analysis.bestMove)
                        : "-"}
                  </p>
                </div>
                <div className="rounded-md bg-white/80 px-3 py-2 text-sm font-semibold text-stone-800">
                  {selectedModeDetails.label}
                </div>
              </div>
              <p className="mt-3 text-sm leading-6 text-amber-950">
                {selectedModeDetails.description}
              </p>
              {isRecommendationDifferentFromTop ? (
                <p className="mt-2 text-sm font-medium text-amber-900">
                  This study recommendation differs from the top engine move,
                  which remains visible below.
                </p>
              ) : null}
              {highlightedMoveSquares.from && highlightedMoveSquares.to ? (
                <p className="mt-2 text-sm font-medium text-amber-900">
                  Highlighted from {highlightedMoveSquares.from} to{" "}
                  {highlightedMoveSquares.to}
                </p>
              ) : null}
            </div>

            {recommendedCandidate ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Selected mode
                  </p>
                  <p className="mt-1 font-semibold text-stone-950">
                    {selectedModeDetails.label}
                    {analysis.usedFallback ? " fallback" : ""}
                  </p>
                </div>
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Evaluation
                  </p>
                  <p className="mt-1 font-semibold text-stone-950">
                    {formatSideToMoveScore(recommendedCandidate.score)}
                  </p>
                </div>
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Loss from best
                  </p>
                  <p className="mt-1 font-semibold text-stone-950">
                    {formatEvaluationLoss(analysis.evaluationLoss)}
                  </p>
                </div>
                <div className="rounded-md border border-stone-200 bg-stone-50 p-3 sm:col-span-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                    Principal variation
                  </p>
                  <p className="mt-1 text-sm leading-6 text-stone-700">
                    {recommendedCandidate.pv.join(" ")}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3">
              {analysis.candidates.map((candidate) => (
                <div
                  className={`rounded-md border p-3 transition hover:border-stone-300 ${
                    recommendedCandidate?.move === candidate.move
                      ? "border-emerald-300 bg-emerald-50"
                      : candidate.multipv === 1
                        ? "border-amber-200 bg-amber-50/50"
                        : "border-stone-200 bg-stone-50"
                  }`}
                  key={`${candidate.multipv}-${candidate.move}`}
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-semibold text-stone-950">
                        {candidate.multipv}. {formatMove(game, candidate.move)}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.12em]">
                        {candidate.multipv === 1 ? (
                          <span className="text-amber-800">Top engine move</span>
                        ) : null}
                        {recommendedCandidate?.move === candidate.move ? (
                          <span className="text-emerald-800">Recommended</span>
                        ) : null}
                      </div>
                    </div>
                    <p className="text-sm font-medium text-stone-700">
                      Eval {formatSideToMoveScore(candidate.score)}
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
