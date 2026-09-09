/**
 * 模型配置页 —— 在页面里完成过去要手改三处文件的事：
 *   ~/.pi/agent/models.json（provider 定义）、仓库 .env（密钥）、
 *   settings.json（默认模型）。
 *
 * 布局沿用编排页（工具条 + 左右可拖分栏）：左侧 provider 台账（同会话栏的
 * 行样式），右侧选中 provider 的编辑器（同节点检查器的表单行）。草稿状态
 * 放在 models-store（zustand）——本页随 tab 切换卸载重挂，本地 useState 会
 * 把未保存的草稿连同已输入的密钥静默丢掉；只有「保存」才落盘，工具条的
 * 「应用」负责激活模型（set_model / 编排默认 / 持久默认，必要时重启 pi 主
 * 进程——新增 provider 或新密钥只有新 pi 进程能看到，这是 pi 的运行时语义，
 * 不是本页的取舍）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { ModelsConfigApplyResponse, ModelsConfigTestRequest } from "@pi-graph/shared";
import { useModelsStore, type Draft } from "./models-store.ts";

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** model id 允许 "/"：openrouter 式 id（meta/llama-3…）是 pi 的正规用法。 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,127}$/;
/** pi KnownApi 的常见值（datalist 建议——自由输入仍然允许）。 */
const KNOWN_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"mistral-conversations",
	"azure-openai-responses",
	"openai-codex-responses",
	"bedrock-converse-stream",
];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRef = (v: unknown): boolean => typeof v === "string" && (v.startsWith("$") || v.startsWith("!"));
const refToVar = (v: string): string => v.replace(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/, "$1");

/** 本地校验（服务端是权威，这里只挡明显错误以免一次网络往返）。 */
function draftIssues(drafts: Draft[]): string[] {
	const issues: string[] = [];
	const ids = new Set<string>();
	for (const d of drafts) {
		if (!PROVIDER_ID_RE.test(d.id)) issues.push(`provider id「${d.id || "（空）"}」非法（字母数字开头，仅 ._− 与数字，≤64 字）`);
		if (ids.has(d.id)) issues.push(`provider id「${d.id}」重复`);
		ids.add(d.id);
		const baseUrl = str(d.raw.baseUrl);
		if (baseUrl && !/^https?:\/\//.test(baseUrl)) issues.push(`「${d.id}」的 Base URL 需为 http(s)`);
		if (str(d.raw.apiKey).startsWith("!") && d.keyInput.trim()) {
			issues.push(`「${d.id}」的密钥是 !command 形式，页面不修改密钥（清空密钥输入框）`);
		}
		const models = Array.isArray(d.raw.models) ? d.raw.models : [];
		const seen = new Set<string>();
		for (const m of models) {
			const id = str((m as { id?: unknown }).id);
			if (!id || !MODEL_ID_RE.test(id)) issues.push(`「${d.id}」的 model id「${id || "（空）"}」非法（字母数字开头，可含 ._+-/，≤128 字）`);
			else if (seen.has(id)) issues.push(`「${d.id}」的 model id「${id}」重复`);
			seen.add(id);
		}
	}
	return issues;
}

// ============================================================================
// 工具条：当前模型 + 目标选择 + 应用
// ============================================================================

function ApplyResultNote({ result }: { result: ModelsConfigApplyResponse | null }) {
	if (!result) return null;
	const parts: string[] = [];
	if (result.chatSwitched) parts.push("主会话已切换");
	if (result.orchUpdated) parts.push("编排默认已更新");
	if (result.persisted) parts.push("持久默认已写入（重启后仍是它）");
	if (result.restarted) parts.push(result.contextResumed ? "pi 已重启，上下文已恢复" : "pi 已重启（新会话上下文）");
	const warn = result.restartError ?? result.chatSwitchError;
	return (
		<span className={warn ? "pg-error-text" : "pg-dim"} title={warn ?? parts.join("；")}>
			{warn ? `⚠ ${warn}` : `✓ ${parts.join("；") || "已应用"}`}
		</span>
	);
}

function ModelsBar() {
	const config = useModelsStore((s) => s.config);
	const applying = useModelsStore((s) => s.applying);
	const applyError = useModelsStore((s) => s.applyError);
	const applyResult = useModelsStore((s) => s.applyResult);
	const apply = useModelsStore((s) => s.apply);
	const [target, setTarget] = useState("");
	const [restart, setRestart] = useState(false);

	// 选项：配置里的全部 provider/model + 运行时快照里多出来的
	const options = useMemo(() => {
		if (!config) return [] as { value: string; label: string; extra: boolean }[];
		const list: { value: string; label: string; extra: boolean }[] = [];
		for (const [pid, p] of Object.entries(config.providers)) {
			for (const m of p.models) list.push({ value: `${pid}/${m.id}`, label: `${p.name ?? pid} · ${m.name ?? m.id}`, extra: false });
		}
		const known = new Set(list.map((o) => o.value));
		for (const m of config.runtimeModels) {
			const value = `${m.provider}/${m.id}`;
			if (!known.has(value)) list.push({ value, label: `${m.provider} · ${m.id}`, extra: true });
		}
		return list;
	}, [config]);

	useEffect(() => {
		// 默认选中当前模型；pi 不在时退到持久默认，再退到第一项
		if (!config || options.length === 0) return;
		if (target && options.some((o) => o.value === target)) return;
		const active = config.activeModel ? `${config.activeModel.provider}/${config.activeModel.id}` : "";
		const persisted = config.persistedDefault ? `${config.persistedDefault.provider}/${config.persistedDefault.modelId}` : "";
		setTarget(options.some((o) => o.value === active) ? active : options.some((o) => o.value === persisted) ? persisted : (options[0]?.value ?? ""));
	}, [config, options, target]);

	const inRuntime = target ? (config?.runtimeModels ?? []).some((m) => `${m.provider}/${m.id}` === target) : false;
	const submit = () => {
		if (!target) return;
		const req = { activeModel: target, restartBridge: restart || undefined };
		if (restart && !window.confirm(`将重启 pi 主进程以使模型配置生效。\n当前对话的上下文会自动恢复（新进程重新加载配置）。\n\n确定重启并应用 ${target}？`)) return;
		void apply(req);
	};
	return (
		<div className="pg-orch-bar">
			<b className="pg-models-bar-label">当前模型</b>
			<span className="pg-orch-chip">{config?.activeModel ? `${config.activeModel.provider}/${config.activeModel.id}` : "—"}</span>
			<span className="pg-dim" title="settings.json 里的持久默认（重启后 pi 的初始模型）">
				持久默认 {config?.persistedDefault ? `${config.persistedDefault.provider}/${config.persistedDefault.modelId}` : "未设置"}
			</span>
			<span className="pg-dim" title="编排节点与 AI 规划器使用的模型（apply 时一并更新）">
				编排 {config?.orchDefaults.nodeDefault ?? "—"}
			</span>
			<span className="pg-models-spacer" />
			<label className="pg-dim" htmlFor="pg-model-target">
				切换为
			</label>
			<select
				id="pg-model-target"
				className="pg-form-input"
				value={target}
				onChange={(e) => setTarget(e.target.value)}
				disabled={options.length === 0}
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
						{o.extra ? "（运行时）" : ""}
					</option>
				))}
			</select>
			{target && !inRuntime && (
				<span className="pg-error-text" title="pi 在启动时快照可用模型；新增/修改 provider 或新密钥只对新进程可见">
					此模型对当前 pi 不可见——勾选重启后应用
				</span>
			)}
			<label className="pg-dim" title="重启 pi 主进程（上下文自动恢复）：新增 provider、改 Base URL 或首次写入密钥后需要">
				<input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /> 重启 pi
			</label>
			<button className="pg-btn pg-btn-sm" disabled={!target || applying} onClick={submit}>
				{applying ? "应用中…" : "应用"}
			</button>
			<ApplyResultNote result={applyResult} />
			{applyError && <span className="pg-error-text">{applyError}</span>}
		</div>
	);
}

// ============================================================================
// 左栏：provider 台账
// ============================================================================

function ProviderList({
	drafts,
	selectedKey,
	onSelect,
	onAdd,
}: {
	drafts: Draft[];
	selectedKey: string | null;
	onSelect: (key: string) => void;
	onAdd: () => void;
}) {
	const config = useModelsStore((s) => s.config);
	const activeProvider = config?.activeModel?.provider;
	return (
		<aside className="pg-sessions pg-models-side" aria-label="provider 列表">
			<header className="pg-sessions-head">
				<b>Provider</b>
				<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={onAdd} title="新增一个模型 provider（保存后写入 models.json）">
					＋ 新增
				</button>
			</header>
			<ul className="pg-sessions-list">
				{drafts.map((d) => {
					const info = config?.providers[d.id];
					const kref = str(d.raw.apiKey);
					const selected = d.key === selectedKey;
					return (
						<li key={d.key}>
							<button
								className={`pg-session-item${selected ? " active" : ""}`}
								aria-current={selected ? "true" : undefined}
								onClick={() => onSelect(d.key)}
								title={str(d.raw.baseUrl) || "未设置 Base URL"}
							>
								<div className="pg-session-title">
									{activeProvider === d.id && <span className="pg-session-mark">当前</span>}
									{d.isNew ? <span className="pg-session-mark">新</span> : null}
									{str(d.raw.name) || d.id}
									<span className="pg-dim"> · {d.id}</span>
								</div>
								<div className="pg-dim">
									{(Array.isArray(d.raw.models) ? d.raw.models.length : 0) || info?.models.length || 0} 模型
									{" · "}
									{info
										? kref.startsWith("!")
											? "密钥 !cmd"
											: info.apiKeyInline
												? "密钥内联"
												: info.apiKeyEnvSet
													? "密钥 ✓"
													: "密钥 ✗"
										: d.keyInput
											? "密钥 ✓"
											: "密钥？"}
									{info && info.advancedFields.length > 0 && <span className="pg-session-badge">+{info.advancedFields.length} 高级字段</span>}
								</div>
							</button>
						</li>
					);
				})}
				{drafts.length === 0 && (
					<li className="pg-dim pg-sessions-note">
						暂无 provider——「＋ 新增」创建一个（例如 DeepSeek：Base URL https://api.deepseek.com/v1 + 密钥）
					</li>
				)}
			</ul>
		</aside>
	);
}

// ============================================================================
// 右栏：provider 编辑器
// ============================================================================

function ProviderEditor({
	draft,
	onChange,
	onDelete,
	onSave,
	saving,
}: {
	draft: Draft;
	onChange: (next: Draft) => void;
	onDelete: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	const test = useModelsStore((s) => s.test);
	const testing = useModelsStore((s) => s.testing[draft.key] === true);
	const testResult = useModelsStore((s) => s.testResults[draft.key]);
	const info = useModelsStore((s) => (s.config ? s.config.providers[draft.id] : undefined));
	const modelsPath = useModelsStore((s) => s.config?.modelsPath);

	const setField = (field: string, value: unknown) => onChange({ ...draft, raw: { ...draft.raw, [field]: value } });
	const models: Record<string, unknown>[] = Array.isArray(draft.raw.models) ? (draft.raw.models as Record<string, unknown>[]) : [];
	const setModel = (i: number, patch: Record<string, unknown>) => {
		const next = models.map((m, j) => (j === i ? { ...m, ...patch } : m));
		setField("models", next);
	};
	const ref = str(draft.raw.apiKey);
	const cmdKey = ref.startsWith("!");

	const runTest = () => {
		// 与服务器一致的「已保存判定」：草稿自加载后没动过 → 按 id 测（走
		// models.json + env 解引用）；动过/新草稿 → 用当前字段直测（$VAR 引用
		// 必须走 apiKeyRef 通道，apiKey 通道会被当成字面量发出去）
		const saved = info?.raw;
		const modified = draft.isNew || !saved || draft.keyInput.trim() !== "" || JSON.stringify(saved) !== JSON.stringify(draft.raw);
		const typed = draft.keyInput.trim();
		const req: ModelsConfigTestRequest = modified
			? {
					baseUrl: str(draft.raw.baseUrl),
					api: str(draft.raw.api) || undefined,
					apiKey: typed || undefined,
					apiKeyRef: !typed && isRef(draft.raw.apiKey) && !cmdKey ? ref : undefined,
				}
			: { provider: draft.id };
		void test(req, draft.key);
	};
	const keyPlaceholder = cmdKey
		? "!command 形式——页面不编辑、不测试（原样保留）"
		: info?.apiKeyInline
			? "已内联保存——输入新值替换"
			: info?.apiKeyEnvSet
				? `已设置（${ref}）——输入以更新`
				: ref
					? `${ref} 未设置——输入密钥`
					: "sk-…（输入 API 密钥，保存后写入 .env）";

	return (
		<aside className="pg-panel pg-models-editor">
			<header>
				<b>{str(draft.raw.name) || draft.id || "新 provider"}</b>
				<code className="pg-dim">{draft.id}</code>
			</header>
			{draft.isNew && (
				<div className="pg-form-row">
					<label htmlFor="pg-model-pid">Provider ID（保存后不可改；用于 provider/model 引用）</label>
					<input
						id="pg-model-pid"
						className="pg-form-input"
						value={draft.id}
						placeholder="如 deepseek、kimi"
						onChange={(e) => onChange({ ...draft, id: e.target.value.trim() })}
					/>
				</div>
			)}
			<div className="pg-form-row">
				<label htmlFor="pg-model-name">显示名（可选）</label>
				<input id="pg-model-name" className="pg-form-input" value={str(draft.raw.name)} onChange={(e) => setField("name", e.target.value)} />
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-model-api">API 类型（决定请求形态与测试方式）</label>
				<input
					id="pg-model-api"
					className="pg-form-input"
					list="pg-known-apis"
					value={str(draft.raw.api)}
					placeholder="openai-completions"
					onChange={(e) => setField("api", e.target.value)}
				/>
				<datalist id="pg-known-apis">
					{KNOWN_APIS.map((a) => (
						<option key={a} value={a} />
					))}
				</datalist>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-model-url">Base URL</label>
				<input
					id="pg-model-url"
					className="pg-form-input"
					value={str(draft.raw.baseUrl)}
					placeholder="https://api.deepseek.com/v1"
					onChange={(e) => setField("baseUrl", e.target.value)}
				/>
			</div>
			<div className="pg-form-row">
				<label htmlFor="pg-model-key">
					API 密钥{ref ? `（引用 ${ref}，明文存 .env、models.json 只留引用）` : "（保存时自动建 $VAR 引用并写入 .env）"}
				</label>
				<input
					id="pg-model-key"
					className="pg-form-input"
					type="password"
					autoComplete="off"
					value={draft.keyInput}
					placeholder={keyPlaceholder}
					onChange={(e) => onChange({ ...draft, keyInput: e.target.value })}
				/>
				{info && ref && !cmdKey && !info.apiKeyEnvSet && !info.apiKeyInline && !draft.keyInput && (
					<p className="pg-error-text">环境变量未设置——该 provider 的模型不会出现在可用列表里</p>
				)}
			</div>
			<div className="pg-form-row">
				<label>模型（id 用于 provider/model 引用与编排节点）</label>
				{models.map((m, i) => (
					<div className="pg-model-row" key={i}>
						<input
							className="pg-form-input"
							value={str(m.id)}
							placeholder="model id（如 deepseek-chat）"
							aria-label={`model ${i + 1} id`}
							onChange={(e) => setModel(i, { id: e.target.value })}
						/>
						<input
							className="pg-form-input"
							value={str(m.name)}
							placeholder="显示名（可选）"
							aria-label={`model ${i + 1} 显示名`}
							onChange={(e) => setModel(i, { name: e.target.value })}
						/>
						<label className="pg-dim" title="推理模型（reasoning）标记">
							<input
								type="checkbox"
								checked={m.reasoning === true}
								onChange={(e) => setModel(i, { reasoning: e.target.checked })}
							/>
							推理
						</label>
						<button
							className="pg-btn pg-btn-ghost pg-btn-sm"
							title="移除此模型"
							aria-label={`移除 model ${str(m.id) || i + 1}`}
							onClick={() => setField("models", models.filter((_, j) => j !== i))}
						>
							✕
						</button>
					</div>
				))}
				<button className="pg-btn pg-btn-ghost pg-btn-sm" onClick={() => setField("models", [...models, { id: "" }])}>
					＋ 添加模型
				</button>
			</div>
			{info && info.advancedFields.length > 0 && (
				<p className="pg-dim">高级字段（{info.advancedFields.join("、")}）本页不编辑，保存时原样保留。</p>
			)}
			<div className="pg-model-actions">
				<button
					className="pg-btn pg-btn-sm"
					disabled={!str(draft.raw.baseUrl) || testing || cmdKey}
					onClick={runTest}
					title={cmdKey ? "!command 密钥经 shell 执行，页面不支持测试" : "对该 provider 的「列模型」端点发一次零 token 请求，验证 URL 与密钥"}
				>
					{testing ? "测试中…" : "测试连接"}
				</button>
				<button className="pg-btn pg-btn-sm" disabled={saving} onClick={onSave}>
					{saving ? "保存中…" : "保存全部改动"}
				</button>
				{!draft.isNew && (
					<button className="pg-btn pg-btn-danger pg-btn-sm" onClick={onDelete}>
						删除 provider
					</button>
				)}
			</div>
			{testResult && (
				<p className={testResult.ok ? "pg-dim" : "pg-error-text"} title={testResult.probedUrl ?? undefined}>
					{testResult.ok ? "✓" : "✗"} {testResult.message}
					{testResult.status ? `（HTTP ${testResult.status}）` : ""}
				</p>
			)}
			<p className="pg-dim">
				保存写入 <code>{modelsPath ?? "~/.pi/agent/models.json"}</code>；密钥写入仓库根 <code>.env</code>（已被 gitignore）。新增 provider / 新密钥对已运行的 pi 不可见——保存后在顶部勾选「重启 pi」再应用。
			</p>
		</aside>
	);
}

// ============================================================================
// 页面
// ============================================================================

export function ModelsPage() {
	const config = useModelsStore((s) => s.config);
	const loading = useModelsStore((s) => s.loading);
	const error = useModelsStore((s) => s.error);
	const saving = useModelsStore((s) => s.saving);
	const load = useModelsStore((s) => s.load);
	const save = useModelsStore((s) => s.save);
	const drafts = useModelsStore((s) => s.drafts);
	const selectedKey = useModelsStore((s) => s.selectedKey);
	const dirty = useModelsStore((s) => s.dirty);
	const setDrafts = useModelsStore((s) => s.setDrafts);
	const setSelectedKey = useModelsStore((s) => s.setSelectedKey);
	const setDirty = useModelsStore((s) => s.setDirty);
	const layout = useDefaultLayout({ id: "pg-models-main", storage: localStorage });

	// 并发编辑守卫：每次草稿变动递增。保存成功后只有计数未变才以服务器状态
	// 重建草稿——保存网络往返期间敲进来的输入是「未保存改动」，不能被覆盖。
	const editGen = useRef(0);
	const bump = () => {
		editGen.current += 1;
	};

	// 初次进入加载；之后 save/apply 内部自会刷新。带未保存改动时不用服务器
	// 状态覆盖草稿（apply 也会触发 load——编辑到一半不应被清掉）。
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		if (!config || dirty) return;
		setDrafts(
			Object.entries(config.providers).map(([id, p]) => ({
				key: id,
				id,
				isNew: false,
				raw: { ...p.raw },
				keyInput: "",
			})),
		);
		const prev = useModelsStore.getState().selectedKey;
		setSelectedKey(prev && Object.hasOwn(config.providers, prev) ? prev : (Object.keys(config.providers)[0] ?? null));
	}, [config, dirty, setDrafts, setSelectedKey]);

	const issues = draftIssues(drafts);
	const selected = drafts.find((d) => d.key === selectedKey) ?? null;

	const update = (next: Draft) => {
		bump();
		setDirty(true);
		setDrafts(useModelsStore.getState().drafts.map((d) => (d.key === next.key ? next : d)));
	};
	const addDraft = () => {
		const key = `__new_${Date.now()}`;
		bump();
		setDirty(true);
		setDrafts([...useModelsStore.getState().drafts, { key, id: "", isNew: true, raw: { api: "openai-completions" }, keyInput: "" }]);
		setSelectedKey(key);
	};
	const removeDraft = async (draft: Draft) => {
		if (!window.confirm(`删除 provider「${draft.id}」？models.json 里的对应条目将被移除（当前全部未保存改动会一并保存）`)) return;
		const rest = drafts.filter((d) => d.key !== draft.key);
		// 删除即保存：其余草稿若有校验问题先挡下——例如新草稿 id 与现存
		// provider 同名时，buildProviders 的后写覆盖会静默顶掉那个 provider
		const restIssues = draftIssues(rest);
		if (restIssues.length > 0) {
			window.alert(`先修复问题再删除：\n${restIssues.join("\n")}`);
			return;
		}
		bump();
		const gen = editGen.current;
		const ok = await save({ providers: buildProviders(rest), secrets: buildSecrets(rest) });
		if (ok) {
			if (editGen.current === gen) setDirty(false); // effect 以服务器状态重建（被删项消失）
			return; // 保存窗口内有新编辑 → 保持 dirty，草稿保留那些编辑
		}
		// 保存失败：只把被删项从「当前」草稿里摘掉（保留保存窗口内的其他编辑）
		setDrafts(useModelsStore.getState().drafts.filter((d) => d.key !== draft.key));
		const cur = useModelsStore.getState().selectedKey;
		setSelectedKey(cur === draft.key ? (rest[0]?.key ?? null) : cur);
	};
	const doSave = async () => {
		if (issues.length > 0) return; // 按钮已禁用；防御
		const gen = editGen.current;
		const ok = await save({ providers: buildProviders(drafts), secrets: buildSecrets(drafts) });
		if (ok && editGen.current === gen) setDirty(false);
	};

	return (
		<div className="pg-app pg-orch-page">
			<ModelsBar />
			{config?.configError && (
				<div className="pg-orch-bar">
					<span className="pg-error-text" title={config.configError}>
						models.json 读取失败：{config.configError}——修复后刷新
					</span>
				</div>
			)}
			<div className="pg-main">
				<Group orientation="horizontal" className="pg-pgroup" {...layout}>
					<Panel id="models-list" className="pg-fill" defaultSize="30" minSize={220}>
						<ProviderList drafts={drafts} selectedKey={selectedKey} onSelect={setSelectedKey} onAdd={addDraft} />
					</Panel>
					<Separator className="pg-rh pg-rh-col" title="拖拽调整 · 双击复位" aria-label="拖动调整 provider 列表与编辑器的宽度" />
					<Panel id="models-editor" className="pg-fill" defaultSize="70" minSize={360}>
						{selected ? (
							<ProviderEditor
								draft={selected}
								onChange={update}
								onDelete={() => void removeDraft(selected)}
								onSave={() => void doSave()}
								saving={saving}
							/>
						) : (
							<aside className="pg-panel">
								<header>
									<b>模型配置</b>
								</header>
								<p className="pg-dim">
									{loading
										? "加载中…"
										: "左侧选择一个 provider 编辑，或「＋ 新增」创建。这里管理 ~/.pi/agent/models.json、密钥（.env）与默认模型——不再需要手工编辑文件。"}
								</p>
							</aside>
						)}
						{error && (
							<p className="pg-error-text" style={{ padding: "8px 16px" }}>
								{error}
							</p>
						)}
					</Panel>
				</Group>
			</div>
			{issues.length > 0 && dirty && (
				<div className="pg-orch-bar">
					<span className="pg-error-text" title={issues.join("\n")}>
						⚠ {issues.length} 个待修复问题（{issues[0]}）
					</span>
					<button className="pg-btn pg-btn-ghost pg-btn-sm" disabled={saving || issues.length > 0} onClick={() => void doSave()}>
						{saving ? "保存中…" : "保存全部改动"}
					</button>
				</div>
			)}
			{issues.length === 0 && dirty && (
				<div className="pg-orch-bar">
					<span className="pg-dim">有未保存的改动</span>
					<button className="pg-btn pg-btn-sm" disabled={saving} onClick={() => void doSave()}>
						{saving ? "保存中…" : "保存全部改动"}
					</button>
					<button
						className="pg-btn pg-btn-ghost pg-btn-sm"
						onClick={() => {
							if (window.confirm("放弃全部未保存的改动？")) setDirty(false); // effect 以服务器状态重建草稿
						}}
					>
						放弃改动
					</button>
				</div>
			)}
		</div>
	);
}

/** 草稿 → PUT providers（密钥输入折算进 raw：引用则留 ref，否则作为字面量交给 server 转写）。 */
function buildProviders(drafts: Draft[]): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const d of drafts) {
		const raw = { ...d.raw };
		const typed = d.keyInput.trim();
		if (typed && !isRef(raw.apiKey)) raw.apiKey = typed; // 字面量 → server 转 $VAR + .env
		// 引用形式（$VAR/!cmd）+ 输入 → 走 secrets 通道（buildSecrets）
		// 清空的可选字段删除而非写 ""——空串会原样落进 models.json（pi 侧
		// 视为已设置但无效的字段），用户「清掉」的意图应真正生效
		for (const f of ["name", "api", "baseUrl"] as const) if (raw[f] === "") delete raw[f];
		if (Array.isArray(raw.models)) {
			raw.models = (raw.models as Record<string, unknown>[]).map((m) => {
				const next = { ...m };
				if (next.name === "") delete next.name;
				return next;
			});
		}
		out[d.id] = raw;
	}
	return out;
}

/** 密钥输入 → {变量名: 明文}（仅当 raw.apiKey 已是 $VAR 引用时；!cmd 不走此通道）。 */
function buildSecrets(drafts: Draft[]): Record<string, string> {
	const secrets: Record<string, string> = {};
	for (const d of drafts) {
		const typed = d.keyInput.trim();
		const ref = str(d.raw.apiKey);
		if (typed && ref.startsWith("$")) secrets[refToVar(ref)] = typed;
	}
	return secrets;
}
