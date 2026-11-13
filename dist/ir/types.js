/**
 * IR = 需求确认的唯一真相源。
 *
 * 只有两样东西是"作者写的"：actor 和 assertion。
 * 实体、状态、入口、终态全部从 assertion 推导 —— 少写一种数据，就少一种不一致。
 */
export const ACTOR_TYPES = ["human", "anonymous", "system", "external", "virtual", "batch"];
/**
 * 伪状态：对象还不存在。
 * `∅ --create--> draft` 是创建，`draft --discard--> ∅` 是消亡。
 * 把「入口」显式化，就不用猜哪个状态是起点了。
 */
export const EMPTY_STATE = "∅";
export const EMPTY_ALIASES = new Set(["∅", "-", "none", "(none)", "null", ""]);
export function emptyIR(product) {
    return {
        product,
        version: 0,
        updatedAt: new Date().toISOString(),
        actors: [],
        assertions: [],
        terminals: [],
        changesets: [],
        tombstones: [],
    };
}
export function terminalKey(entity, state) {
    return `${entity}:${state}`;
}
