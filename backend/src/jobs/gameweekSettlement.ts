import { prisma } from "../config/db.js";
import {
  ChipType,
  LeagueStatus,
  MembershipStatus,
  ScoringType,
} from "../types/index.js";
import { fplSyncService } from "../services/fpl/fplSyncService.js";
import { scoringService } from "../services/scoring/scoringService.js";
import { squadService } from "../services/squad/squadService.js";
import { leagueService } from "../services/league/leagueService.js";
import { parseLeagueScoringConfig } from "../models/leagueScoringConfig.js";

/**
 * A gameweek can be settled once all its fixtures are finished.
 * FPL only sets `finished` after bonus points are confirmed
 * (`finished_provisional` covers the pre-bonus state).
 */
export function isGameweekReadyForSettlement(fixtures: Array<{ finished: boolean }>): boolean {
  return fixtures.length > 0 && fixtures.every((f) => f.finished);
}

/**
 * Settles one gameweek: final stats sync, squad scores (auto-subs and chips applied),
 * Free Hit reverts, H2H results and completion of leagues ending this gameweek.
 * Every step is idempotent, so a retried job does not double count.
 */
export async function settleGameweek(gameweekId: number): Promise<void> {
  const gameweek = await prisma.gameweek.findUniqueOrThrow({
    where: { id: gameweekId },
  });

  await fplSyncService.syncGameweekLiveStats(gameweek.fplId);

  const squads = await prisma.squad.findMany({ select: { id: true } });
  for (const squad of squads) {
    await scoringService.calculateAndPersistSquadScore(squad.id, gameweekId);
  }

  const leagues = await prisma.league.findMany({
    where: {
      status: LeagueStatus.ACTIVE,
      startGameweekId: { lte: gameweekId },
      endGameweekId: { gte: gameweekId },
    },
  });
  for (const league of leagues) {
    const scoringConfig = league.scoringConfig
      ? parseLeagueScoringConfig(league.scoringConfig)
      : null;
    if (!scoringConfig) {
      continue;
    }
    const members = await prisma.leagueMember.findMany({
      where: { leagueId: league.id, status: MembershipStatus.ACTIVE },
      select: { squadId: true },
    });
    await Promise.all(
      members.map((member) =>
        scoringService.calculateAndPersistLeagueScore(
          league.id,
          member.squadId,
          gameweekId,
          scoringConfig
        )
      )
    );
  }

  const freeHits = await prisma.squadChipUsage.findMany({
    where: { gameweekId, chipType: ChipType.FREE_HIT, revertedAt: null },
    select: { squadId: true },
  });
  for (const usage of freeHits) {
    await squadService.revertFreeHit(usage.squadId, gameweekId);
  }

  for (const league of leagues) {
    const hasCustomScoring = league.scoringConfig !== null;
    if (league.scoringType === ScoringType.HEAD_TO_HEAD) {
      await leagueService.settleH2HGameweek(
        league.id,
        gameweekId,
        hasCustomScoring
      );
    }
    if (league.endGameweekId === gameweekId) {
      await leagueService.transitionStatus(league.id, LeagueStatus.COMPLETED);
    }
  }

  await prisma.gameweek.update({
    where: { id: gameweekId },
    data: { isFinished: true, settledAt: new Date() },
  });
}

/**
 * Gameweek Completion & Settlement Job.
 * Settles every locked, unsettled gameweek whose fixtures are all finished.
 */
export async function settleCompletedGameweeks(): Promise<number[]> {
  const gameweeks = await prisma.gameweek.findMany({
    where: { isLocked: true, settledAt: null },
    include: { fixtures: { select: { finished: true } } },
    orderBy: { id: "asc" },
  });

  const settled: number[] = [];
  for (const gw of gameweeks) {
    if (isGameweekReadyForSettlement(gw.fixtures)) {
      await settleGameweek(gw.id);
      settled.push(gw.id);
    }
  }
  return settled;
}
