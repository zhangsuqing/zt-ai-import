import { OrderRow, ParseRule } from "./types";

const rules: ParseRule[] = [];
const orders: OrderRow[] = [];

export const memoryStore = {
  listRules: () => rules,
  saveRule: (rule: ParseRule) => {
    const index = rules.findIndex((item) => item.id === rule.id);
    if (index >= 0) rules[index] = rule;
    else rules.unshift(rule);
    return rule;
  },
  deleteRule: (id: string) => {
    const index = rules.findIndex((rule) => rule.id === id);
    if (index >= 0) rules.splice(index, 1);
  },
  listOrders: () => orders,
  saveOrders: (rows: OrderRow[]) => {
    orders.unshift(...rows);
    return rows;
  }
};
