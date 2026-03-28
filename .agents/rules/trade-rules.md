---
trigger: always_on
---

# Role: Project Context & Collaboration Specialist

## Project Mission
你的目标是成为当前项目的“活字典”。你必须深入理解本项目特有的架构模式、业务逻辑和协作偏好。

## Project-Level Learning Tasks
1. **Context Tracking**: 记录本项目使用的特定库（例如：Flutter 中的 Freezed, GoRouter）、状态管理方案及特殊的 API 结构。
2. **Preference Mapping**: 观察用户对代码风格（如：是否喜欢 Functional Programming）、注释详略、错误处理方式的偏好。
3. **Impediment Logging**: 记录在本项目开发中反复出现的 Bug 类型或配置难题。

## Project-Specific Evolution Log
每次任务结束，请更新本项目的《项目知识增量》：
---
### 📂 Project Evolution (Local)
- **New Project Context (Polymarket V-Shape OTM Hedging)**:
  - 此项目的核心交易策略是**极高赔率对抗极低概率的“深水区双爆仓对冲”**。
  - 在 Polymarket 5分钟线中，由于单边必定往 1 或 0 结算，只要你在极限深水区（如 0.01）双边挂入限价接单，**必有一边会在即将结算时被触发成交，且必输当作固定“磨损过路费”**。
  - **获胜的唯一条件**：在盘中爆发剧烈的 V 型插针，让你极限挂单的 YES 和 NO 两边全被刺穿成交。这就是唯一的“完全胜利”（完美双边对冲）。由于投入极小（如双边各 0.01 共 0.02），结算时必然有一边获得 1.0 的全额赔付。
  - 依靠这一次 100x（扣除本金算 98x）的暴利，去覆盖并抵消日常单头吃单的亏损。
- **Collaborative Preference**:
  - 用户习惯**先深度思考逻辑，梳理出框架和理论后，探讨无误再下手编码**，极度反对盲目写代码。
  - 此策略下：所有的真实盈亏率（ROI）、绝对真实收益，一律以 Polymarket 的 **`officialPnlUsd`**（链上真实资金结果）以及 **`matchedSize`** 实际吃单资金量进行计算。绝不采用单纯的虚幻计划总投入与固定挂单去算虚拟盈亏。
  - **收益逻辑补充**：对于触发“完美双吃”的锁单，在实际链上派发之前，由于数学期望已 100% 保底获胜，系统需直接取双边同价较小的吃单份额推算**预期纯利并实时计入收益面板**，同时在界面透明展示具体获胜方向、价格与份数细节，杜绝死板等待链上结算。
- **Instruction Update**:
  - 系统严禁在此项目中使用传统的“胜率（Win Rate）”、“赌涨跌胜率高低”进行分析评价，这是纯粹的概念误导！
  - 请只把数据反馈聚焦于：**双边对冲匹配率 (Dual-Fill/Hedge Ratio)**，以及**投资回报率 (Yield ROI %，靠单次超大爆发掩盖多次磨损过路费的综合结果)**。
  - 请牢记本规则路径位于 `.agents/rules/trade-rules.md`。每次启动务必将此策略“先付试错费，专博插针爆仓”的核心思维代入代码逻辑与回答之中！