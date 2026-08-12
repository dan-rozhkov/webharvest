/**
 * Узел гибридного дерева: роль и имя берутся из accessibility-дерева, тег и
 * скроллируемость — из DOM. Поля `nodeId`/`parentId`/`childIds` — сырые
 * идентификаторы AX-дерева, живут только внутри одного захвата. Наружу
 * адресом служит `encodedId`.
 */
export interface A11yNode {
  role: string;
  name?: string;
  description?: string;
  value?: string;
  selected?: boolean;
  checked?: boolean;
  nodeId: string;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
  /** `${frameOrdinal}-${backendNodeId}` — то, что видит модель. */
  encodedId?: string;
  children?: A11yNode[];
}

/**
 * Результат захвата страницы. `outline` уходит в промпт, карты остаются на
 * нашей стороне: модель возвращает ID, мы по ним резолвим узел, ссылку и тег.
 */
export interface A11ySnapshot {
  outline: string;
  /** encodedId → href. Ссылки в дерево не печатаются, чтобы модель их не выдумывала. */
  urlMap: Record<string, string>;
  /** encodedId → абсолютный XPath. Запасной путь резолва и переживание перезагрузки. */
  xpathMap: Record<string, string>;
  /** encodedId → имя тега, у input дополнено типом: `input, password`. */
  tagNameMap: Record<string, string>;
}
