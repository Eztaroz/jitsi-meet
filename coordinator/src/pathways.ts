/**
 * Pathways: the ordered stages an encounter goes through, which come from the configuration, not the code (ADR 0013).
 * Only `waiting` (first), `done` (last) and `examination` mean anything to the code.
 */
import type { ICenter, ILayout, IPathway, IStage } from './rooms.ts';

export const WAITING = 'waiting';
export const DONE = 'done';

/** The one stage besides `waiting` and `done` that means something to the code: it has a queue per doctor. */
export const EXAMINATION = 'examination';
export const DEFAULT_PATHWAY_ID = 'default';

/**
 * The pathway of a deployment that configures none: the stages and their Thai names. The names are Thai on purpose: the
 * coordinator's screen and the deployment are Thai only and the service runs from source (see CLAUDE.md, story 9 of
 * #14); a deployment that wants other names configures its own `default` pathway (ADR 0013).
 */
export const DEFAULT_PATHWAY: IPathway = {
    id: DEFAULT_PATHWAY_ID,
    stages: [
        { id: WAITING, name: 'รอคิว' },
        { id: 'registration', name: 'ลงทะเบียน' },
        { id: 'intake', name: 'ให้ข้อมูลก่อนพบแพทย์' },
        { id: 'examination', name: 'พบแพทย์' },
        { id: 'aftercare', name: 'หลังพบแพทย์' },
        { id: 'billing', name: 'ชำระเงิน' },
        { id: 'pharmacy', name: 'รับยา' },
        { id: DONE, name: 'เสร็จสิ้น' }
    ]
};

export type PathwayRefusal = 'unknown_center' | 'unknown_clinic';

export interface IResolvedPathway {

    /** The center the encounter belongs to: the one named, else the only one configured. */
    center?: string;

    /** The clinic, if the request named one. */
    clinic?: string;
    pathway: IPathway;
}

/**
 * The pathways a center offers, with the default one among them.
 *
 * @param {ICenter|undefined} center - The center; none for a deployment with no layout.
 * @returns {IPathway[]}
 */
export function pathwaysOf(center: ICenter | undefined): IPathway[] {
    const own = center?.pathways ?? [];

    return own.some(p => p.id === DEFAULT_PATHWAY_ID) ? own : [ ...own, DEFAULT_PATHWAY ];
}

/**
 * Finds a pathway by its id.
 *
 * @param {ILayout} layout - The layout.
 * @param {string} id - The pathway's id.
 * @returns {IPathway|undefined} The first center's that has it, or the default; none when it is not configured.
 */
export function findPathway(layout: ILayout, id: string): IPathway | undefined {
    const centers: (ICenter | undefined)[] = layout.centers.length ? layout.centers : [ undefined ];

    for (const center of centers) {
        const found = pathwaysOf(center).find(p => p.id === id);

        if (found) {
            return found;
        }
    }

    return undefined;
}

/**
 * Resolves the pathway of a new encounter: its clinic's, else its center's, else the default (ADR 0013).
 *
 * @param {ILayout} layout - The layout.
 * @param {Object} where - The center and clinic the request named, if any.
 * @param {string} [where.center] - A center's id.
 * @param {string} [where.clinic] - A clinic's id, in that center.
 * @returns {IResolvedPathway|{ reason: PathwayRefusal }}
 */
export function resolvePathway(layout: ILayout, where: { center?: string; clinic?: string; }): IResolvedPathway | { reason: PathwayRefusal; } {
    let center: ICenter | undefined;

    if (where.center === undefined) {
        center = layout.centers[0];
    } else {
        center = layout.centers.find(c => c.id === where.center);
        if (!center) {
            return { reason: 'unknown_center' };
        }
    }

    const clinic = where.clinic === undefined ? undefined : center?.clinics?.find(c => c.id === where.clinic);

    if (where.clinic !== undefined && !clinic) {
        return { reason: 'unknown_clinic' };
    }

    const id = clinic?.pathway ?? center?.pathway ?? DEFAULT_PATHWAY_ID;
    const pathway = pathwaysOf(center).find(p => p.id === id) ?? DEFAULT_PATHWAY;

    return { center: center?.id, clinic: clinic?.id, pathway };
}

/**
 * The name of a stage in a pathway.
 *
 * @param {ILayout} layout - The layout.
 * @param {string} pathwayId - The encounter's pathway.
 * @param {string} stageId - The stage.
 * @returns {string} The stage's name; its id when the pathway no longer has the stage.
 */
export function stageName(layout: ILayout, pathwayId: string, stageId: string): string {
    return findPathway(layout, pathwayId)?.stages.find(s => s.id === stageId)?.name ?? stageId;
}

/**
 * The stages of every pathway of the layout, each once: the default pathway's first, `done` last.
 *
 * @param {ILayout} layout - The layout.
 * @returns {IStage[]}
 */
export function allStages(layout: ILayout): IStage[] {
    const centers: (ICenter | undefined)[] = layout.centers.length ? layout.centers : [ undefined ];
    const pathways = centers.flatMap(pathwaysOf);
    const ordered = [ ...pathways.filter(p => p.id === DEFAULT_PATHWAY_ID), ...pathways.filter(p => p.id !== DEFAULT_PATHWAY_ID) ];
    const seen = new Map<string, IStage>();

    for (const stage of ordered.flatMap(p => p.stages)) {
        if (!seen.has(stage.id)) {
            seen.set(stage.id, stage);
        }
    }

    const done = seen.get(DONE);

    seen.delete(DONE);

    return [ ...seen.values(), ...done ? [ done ] : [] ];
}

/**
 * Finds the stages that the configuration no longer has but that still hold open encounters.
 *
 * @param {ILayout} layout - The layout.
 * @param {Object[]} encounters - The encounters, with the pathway each follows and the stage it is in.
 * @returns {Object[]} Each such stage, with how many open encounters it holds, in order of first appearance.
 */
export function strandedStages(layout: ILayout, encounters: { pathway: string; stage: string; }[]): { count: number; stage: string; }[] {
    const counts = new Map<string, number>();

    for (const e of encounters) {
        if (e.stage !== DONE && !findPathway(layout, e.pathway)?.stages.some(s => s.id === e.stage)) {
            counts.set(e.stage, (counts.get(e.stage) ?? 0) + 1);
        }
    }

    return [ ...counts ].map(([ stage, count ]) => ({ count, stage }));
}
