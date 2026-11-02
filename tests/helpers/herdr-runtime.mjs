// Native GUI and live-data boundaries for exercising the real mod in Node.
export const state = { data: {}, rendering: false, commands: [], tasks: [], order: [] };
export class View {}
function build() {
  const node = { nodes: [], attributes: {} };
  const proxy = new Proxy(node, {
    get(target, method) {
      if (method in target) return target[method];
      return (...args) => {
        if (["child", "trigger", "content"].includes(method)) { target.nodes.push(args[0]); if(method !== "child") target.attributes[method]=args; }
        else if (method === "children") target.nodes.push(...args[0]);
        else if (method === "when") { if (args[0]) args[1](proxy); }
        else target.attributes[method] = args;
        return proxy;
      };
    },
  });
  return proxy;
}
export const div = build, image = build, svg = build, v_flex = build, h_flex = build;
export const v_resizable = id => build().id(id), resizable_panel = build;
export const Button = { new: id => build().id(id) };
export const Popover = { new: id => build().id(id) };
export const TextView = { markdown: (id, markdown) => build().id(id).markdown(markdown).child(markdown) };
function retainedText(options={}) {
  assertNotRendering();let value=options.value??'';const listeners=new Map();
  return {value:()=>value,set_value(next){if(next===value)return;value=String(next);listeners.get('change')?.({},context());},
    on:(event,handler)=>{listeners.set(event,handler);return true;},release(){},focus(){},set_auto_grow(){},set_rows(){},set_soft_wrap(){}};
}
export const TextareaState = {new:retainedText}, InputState = {new:retainedText};
export const Textarea = {new:state=>build().textarea(state).child(state.value())};
export const Input = {new:state=>build().input(state).child(state.value())};
export const EditorState = {new:retainedText};
export const Editor = {new:state=>build().editor(state).child(state.value())};
export const agents = () => state.data.allAgents;
export const spaces = () => state.data.allSpaces;
export const machines = () => state.data.allMachines ?? [];
export const hc = async () => {assertNotRendering();return {code:0,stdout:JSON.stringify({machines:[]}),stderr:''};};
export const panes = () => state.data.allPanes;
export const terminals = () => state.data.allTerminals;
export const focused = () => state.data.focused ?? ({ space: state.data.selectedSpace });
export const props = () => state.props ?? null;
export const theme = () => new Proxy({}, { get: (_target, key) => state.theme?.[key] ?? "#aabbcc" });
export const layout = () => state.layout ?? ({ id: "sidebar", size: { px: state.width ?? 320 }, children: [{ id: "agents", content: { mod: "space-agents" } }] });
export const shared = key => key === "layout" ? "herdr-workspace" : state.shared?.[key] ?? null;
export const setShared = (key, value) => { state.shared ??= {}; state.shared[key] = value; };
export const window = () => ({ platform: "macos", active:true, titlebar:'none', fullscreen:false, ...state.window });
export const settings = () => ({zoom:1,font_family:'monospace'});
export const setAgentOrder = addresses => { state.order = addresses; };
export const run = (name, args) => { state.commands.push({ name, args }); };
export const openOverlay = options => {state.commands.push({name:'overlay.open',args:options});return 'overlay-test';};
export const exec = async (...args) => {assertNotRendering();return state.execute?state.execute(...args):{ code: 1, stdout: "", stderr: "not a git repository" };};
export const appHome = () => "/fixture/herdr";
export const readTextFile = async path => {assertNotRendering();return Object.hasOwn(state.files??{},path)?state.files[path]:state.sessionView?JSON.stringify(state.sessionView):null;};
export const writeTextFile = async (path,value,expected) => {
  assertNotRendering();state.files??={};
  if((state.files[path]??null)!==expected)throw Error('stale snapshot');
  state.files[path]=value;(state.fileWrites??=[]).push(path);return null;
};
export const watchFolder = async () => { throw new Error("No native watcher in Node"); };
export const knownAgents = async () => [{ key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false,
  tile: "#1c1d21", color: "#ffffff", shell: false, agent: false, run: ["claude"], installed: true }];

export function context() {
  return {
    open_url(url) { state.openedUrls.push(url); },
    write_to_clipboard(text) { state.clipboard=text; },
    focus_handle() {
      assertNotRendering();
      const id=(state.handleCounter??0)+1;state.handleCounter=id;
      return { id, is_focused: () => state.focusedHandle===id, focus(){state.focusedHandle=id;}, release(){} };
    },
    timer: { every(ms,handler) {(state.timers??=[]).push({ms,handler});}, after(ms,handler) {(state.timers??=[]).push({ms,handler,once:true});} },
    spawn(task) { state.tasks.push(() => task(context())); },
    notify() {},
    stop_propagation() {},
  };
}
function assertNotRendering() {
  if (state.rendering) throw new Error("cx.focus_handle() cannot run during render");
}
export function render(view) {
  state.rendering = true;
  try { return view.render(context()); }
  finally { state.rendering = false; }
}
export function text(node) {
  if (typeof node === "string") return [node];
  return (node?.nodes ?? []).flatMap(text);
}
export function find(node, id) {
  if (node?.attributes?.id?.[0] === id) return node;
  if (!node || typeof node !== "object") return;
  for (const child of node.nodes ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
}
