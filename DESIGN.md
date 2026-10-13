# RayGate interface system

## Direction

面向高频运维的浅色控制台。固定白色导航、冷灰工作区、蓝色主操作、紧凑数据表和清晰的非颜色状态文本。所有来源说明必须明确标注为 SSH 真实测试节点，禁止用模拟数据填补空缺。

## Tokens

- Ink `#162235`, muted `#667085`, quiet `#596474`
- Workspace `#f3f5f8`, surface `#ffffff`, line `#dfe4ea`
- Action `#1769d2`, action strong `#1259b5`
- Success `#137a52`, warning `#9a5b13`, danger `#c43d4b`
- Radius: controls 8px, panels 12px, overlays 14px
- Typeface: Chinese system sans stack; tabular numerals for traffic and sessions

## Layout

Desktop uses a 216px fixed sidebar and a dense data workspace. Mobile removes the sidebar and turns table rows into stacked device cards. Traffic detail opens in a right drawer and labels counters as cumulative since the isolated test service started.

## Interaction

Primary actions are blue; status always includes text. Overlays trap focus, Escape closes the active layer, and focus returns to the invoking control. Motion only explains drawers, dialogs, toggles and feedback.
