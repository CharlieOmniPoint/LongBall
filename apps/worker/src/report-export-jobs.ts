import { AccessError } from '../../../packages/application/src/access';
import { ReportExportRepository } from '../../api/src/report-export-repository';
import { ReportExportService } from '../../api/src/report-export-service';
import type { ReportExportOptions } from '../../api/src/report-export-config';
import { ReportPdfError } from '../../api/src/report-export-pdf';
import type { DevelopmentStore } from '../../api/src/store';
import type { PostgresStore } from '../../api/src/postgres-store';

/** Durable leased exports run outside API transactions and never read raw report documents. */
export async function runDueReportExports(source: DevelopmentStore | PostgresStore, options?: ReportExportOptions, maximum = 5) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20) throw new Error('Use a bounded report export batch.');
  const repository = new ReportExportRepository(source); await repository.initialize();
  const result = { completed: 0, retried: 0, failed: 0, expired: await repository.purgeExpired() };
  if (!options) return result;
  const service = new ReportExportService(repository, source, options);
  for (let count = 0; count < maximum; count++) {
    const claim = await repository.claim(); if (!claim) break;
    try {
      const artifact = await service.generate(claim);
      if (await repository.withClaim(claim, () => repository.finish(claim, artifact))) result.completed++;
    } catch (error) {
      const code = error instanceof AccessError || error instanceof ReportPdfError ? error.code : 'EXPORT_GENERATION_FAILED';
      const terminal = error instanceof AccessError || error instanceof ReportPdfError && error.code !== 'EXPORT_FONT_UNAVAILABLE';
      if (await repository.withClaim(claim, () => repository.fail(claim, code, terminal))) {
        if (code === 'EXPORT_EXPIRED') result.expired++;
        else if (terminal || claim.attempt >= 3) result.failed++;
        else result.retried++;
      }
    }
  }
  return result;
}
