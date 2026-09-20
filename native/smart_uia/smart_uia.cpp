// smart_uia.dll —— 智能选区：对齐 Shotera 的 UIA 实现
// 来源：shotera.exe 字符串分析
//   shotera_lib::ui_automation::UiaService
//   src\ui_automation.rs（event @277, @422）
//   RawViewWalker + CreateCacheRequest(RawView) + SetTreeScope(Element|Children)
//   AddProperty(BoundingRectangle / ControlType / IsOffscreen)
//   CreateTrueCondition + FindAll
//   CoCreateInstance(CUIAutomation)
//   设置项：detect_ui_element / uia_hover_anim_ms

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <ole2.h>
#include <oleacc.h>
#include <UIAutomationClient.h>
#include <stdio.h>
#include <cstdlib>
#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>
#include <algorithm>

#pragma comment(lib, "UIAutomationCore.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "oleacc.lib")

struct SmartRect {
  long left, top, right, bottom;
  long width() const { return right - left; }
  long height() const { return bottom - top; }
  long area() const { return (long)width() * height(); }
  bool contains(long x, long y, long margin = 0) const {
    return x >= left - margin && x <= right + margin
        && y >= top - margin && y <= bottom + margin;
  }
};

struct Level {
  SmartRect r;
  std::wstring name;
  std::string controlType;
};

static IUIAutomation* g_automation = nullptr;
static bool g_com_ok = false;
// 共享属性缓存请求：批量取元素时随行带回 BoundingRectangle/ControlType/IsOffscreen/Name，
// 读取走 Cached* 零跨进程往返（Shotera 取证中的 RawView cache request 同款思路）。
static IUIAutomationCacheRequest* g_propsCache = nullptr;
static IUIAutomationCacheRequest* g_ctrlCache = nullptr;

static void ensure_com() {
  if (g_com_ok) return;
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                                IID_IUIAutomation, (void**)&g_automation);
  g_com_ok = (hr == S_OK || hr == S_FALSE) && g_automation != nullptr;
  if (g_com_ok && !g_propsCache) {
    if (SUCCEEDED(g_automation->CreateCacheRequest(&g_propsCache)) && g_propsCache) {
      g_propsCache->AddProperty(UIA_BoundingRectanglePropertyId);
      g_propsCache->AddProperty(UIA_ControlTypePropertyId);
      g_propsCache->AddProperty(UIA_IsOffscreenPropertyId);
      g_propsCache->AddProperty(UIA_NamePropertyId);
    }
    // 控件视图缓存请求（软降级用）：Qt/微信 provider 对 5 属性批量请求可能整体失败或全 false，
    // 失败/零结果时回退 g_propsCache 无过滤快照。
    if (SUCCEEDED(g_automation->CreateCacheRequest(&g_ctrlCache)) && g_ctrlCache) {
      g_ctrlCache->AddProperty(UIA_BoundingRectanglePropertyId);
      g_ctrlCache->AddProperty(UIA_ControlTypePropertyId);
      g_ctrlCache->AddProperty(UIA_IsOffscreenPropertyId);
      g_ctrlCache->AddProperty(UIA_NamePropertyId);
      g_ctrlCache->AddProperty(UIA_IsControlElementPropertyId);
    }
  }
}

static std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::string json_escape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", c);
          o += buf;
        } else o += c;
    }
  }
  return o;
}

// ── 属性读取：缓存优先 ──────────────────────────────────────────────
// 元素来自 FindAllBuildCache / *BuildCache 系 walker 时读 Cached* 零跨进程往返；
// 未经缓存的元素（ElementFromPoint/Handle 直出）Cached* 返回 NOVALUE 失败，自动回退
// Current。此前热路径全部走 Current：每悬停帧约 500 次 COM 往返 × Qt provider 1-3ms/次
// = 0.5-1.5s 延迟，是"识别慢/卡"的直接来源。
static SmartRect rect_of(IUIAutomationElement* el) {
  SmartRect r{0, 0, 0, 0};
  RECT rc{};
  if (el && SUCCEEDED(el->get_CachedBoundingRectangle(&rc))) {
    r.left = rc.left; r.top = rc.top; r.right = rc.right; r.bottom = rc.bottom;
    return r;
  }
  if (el && SUCCEEDED(el->get_CurrentBoundingRectangle(&rc))) {
    r.left = rc.left; r.top = rc.top; r.right = rc.right; r.bottom = rc.bottom;
  }
  return r;
}

static bool is_offscreen(IUIAutomationElement* el) {
  if (!el) return true;
  BOOL off = FALSE;
  if (SUCCEEDED(el->get_CachedIsOffscreen(&off))) return off != FALSE;
  if (FAILED(el->get_CurrentIsOffscreen(&off))) return false;
  return off != FALSE;
}

// 控件视图过滤：RawView 含布局包装节点（网页 div 壳子/自定义容器），框出来对不上任何视觉
// 边界；Shotera 走控件视图只暴露可交互语义元素。FindAll/TrueCondition 按 RawView 枚举，
// 用 IsControlElement 缓存属性剔除非控件节点。
static bool is_control_element(IUIAutomationElement* el) {
  if (!el) return false;
  BOOL ctl = TRUE;
  if (SUCCEEDED(el->get_CachedIsControlElement(&ctl))) return ctl != FALSE;
  if (FAILED(el->get_CurrentIsControlElement(&ctl))) return true;
  return ctl != FALSE;
}

static std::wstring name_of(IUIAutomationElement* el) {
  BSTR b = nullptr;
  if (el && SUCCEEDED(el->get_CachedName(&b)) && b) {
    std::wstring s(b, SysStringLen(b));
    SysFreeString(b);
    return s;
  }
  if (el && SUCCEEDED(el->get_CurrentName(&b)) && b) {
    std::wstring s(b, SysStringLen(b));
    SysFreeString(b);
    return s;
  }
  return L"";
}

static std::string type_of(IUIAutomationElement* el) {
  if (!el) return "";
  int t = 0;
  if (FAILED(el->get_CachedControlType(&t))) {
    if (FAILED(el->get_CurrentControlType(&t))) return "";
  }
  if (t == 50000) return "Button";
  if (t == 50020) return "Edit";
  if (t == 50004) return "Text";
  if (t == 50003) return "List";
  if (t == 50007) return "ListItem";
  if (t == 50002) return "Menu";
  if (t == 50006) return "MenuItem";
  if (t == 50026) return "Tree";
  if (t == 50027) return "TreeItem";
  if (t == 50018) return "Tab";
  if (t == 50019) return "TabItem";
  if (t == 50032) return "Pane";
  if (t == 50034) return "Window";
  if (t == 50030) return "Document";
  if (t == 50028) return "Group";
  if (t == 50029) return "Custom";
  if (t == 50005) return "Image";
  if (t == 50011) return "ScrollBar";
  if (t == 50014) return "Slider";
  if (t == 50015) return "Spinner";
  if (t == 50001) return "ComboBox";
  if (t == 50022) return "CheckBox";
  if (t == 50023) return "RadioButton";
  if (t == 50024) return "Hyperlink";
  if (t == 50021) return "Toolbar";
  if (t == 50031) return "StatusBar";
  if (t == 50016) return "Table";
  if (t == 50017) return "DataItem";
  if (t == 50012) return "Header";
  if (t == 50013) return "HeaderItem";
  if (t == 50025) return "Separator";
  if (t == 50008) return "ProgressBar";
  return "Control";
}

// 对齐 Shotera：CreateCacheRequest(RawView) + 缓存 BoundingRectangle/ControlType/IsOffscreen/Name
static void append_level_cached(IUIAutomationCacheRequest* cache, IUIAutomationElement* el, POINT pt) {
  if (!el) return;
  SmartRect r = rect_of(el);
  if (r.width() < 8 || r.height() < 8) return;
  if (!r.contains(pt.x, pt.y, 2)) return;
  if (r.width() > 2400 && r.height() > 1400) return;
  if (is_offscreen(el)) return;
  Level lv;
  lv.r = r;
  lv.name = name_of(el);
  lv.controlType = type_of(el);
  // 去重
  // caller handles
}

// 找含光标且更小的子元素。rect 在过滤时已经算好随元素一起返回（COM 取矩形很贵，禁止重复取）。
// 2026-09-18：Qt/微信（及部分 Electron）provider 对 FindAllBuildCache 返回空数组（树明明有子级，
// 托管 UIA 普通 FindAll 可枚举 15 个 ListItem）→ 钻取断链，应用内整窗大框。故缓存枚举为空时
// 回退 RawViewWalker 手动遍历（Shotera 主路径即 RawViewWalker）。
typedef std::pair<SmartRect, IUIAutomationElement*> KidItem;
static void collect_raw_children(IUIAutomation* auto_, IUIAutomationElement* parent,
                                 POINT pt, std::vector<KidItem>& out) {
  if (!auto_ || !parent) return;
  IUIAutomationElementArray* arr = nullptr;
  if (g_propsCache) {
    IUIAutomationCondition* cond = nullptr;
    auto_->CreateTrueCondition(&cond);
    if (cond) {
      parent->FindAllBuildCache(TreeScope_Children, cond, g_propsCache, &arr);
      cond->Release();
    }
  }
  if (arr) {
    int n = 0;
    arr->get_Length(&n);
    for (int i = 0; i < n && i < 32; i++) {
      IUIAutomationElement* ch = nullptr;
      arr->GetElement(i, &ch);
      if (!ch) continue;
      SmartRect r = rect_of(ch);
      if (r.width() >= 8 && r.height() >= 8 && r.contains(pt.x, pt.y, 1)
          && r.area() < 2400 * 1400 && !is_offscreen(ch)) {
        out.push_back({ r, ch });
      } else {
        ch->Release();
      }
    }
    arr->Release();
  }

  if (!out.empty()) return;
  // 回退：RawViewWalker 逐个遍历（不依赖 provider 支持批量缓存枚举）。
  // BuildCache 变体让每个兄弟元素的属性随导航一次带回（每元素 1 次跨进程调用而非 2+）。
  IUIAutomationTreeWalker* walker = nullptr;
  auto_->get_RawViewWalker(&walker);
  if (!walker) return;
  IUIAutomationElement* cur = nullptr;
  if (g_propsCache) walker->GetFirstChildElementBuildCache(parent, g_propsCache, &cur);
  else walker->GetFirstChildElement(parent, &cur);
  int guard = 0;
  while (cur && guard++ < 64) {
    IUIAutomationElement* next = nullptr;
    if (g_propsCache) walker->GetNextSiblingElementBuildCache(cur, g_propsCache, &next);
    else walker->GetNextSiblingElement(cur, &next);
    SmartRect r = rect_of(cur);
    if (r.width() >= 8 && r.height() >= 8 && r.contains(pt.x, pt.y, 1)
        && r.area() < 2400 * 1400) {
      out.push_back({ r, cur });  // 所有权转移
    } else {
      cur->Release();
    }
    cur = next;
  }
  walker->Release();
}

// 钻取工作量预算：防止"逐候选递归"在巨型树（浏览器文档）上爆炸（COM 往返 × 深度 × 候选数）
static int g_drillBudget = 0;

static IUIAutomationElement* drill_deepest_raw(IUIAutomation* auto_, IUIAutomationElement* root,
                                              POINT pt, int depthLeft) {
  if (!root || depthLeft <= 0 || g_drillBudget <= 0) return nullptr;
  SmartRect bestR = rect_of(root);
  std::vector<KidItem> kids;
  g_drillBudget--;
  collect_raw_children(auto_, root, pt, kids);
  // 面积升序（rect 已缓存，排序零 COM 开销）。
  // 2026-09-18 微信：首个子元素即全窗大小的 MMUIRenderSubWindowHW 遮罩 pane（与真内容 Group
  // 只差 1px²），"选最小含点子元素"会钻进这个空子树卡死在窗级。改为按面积升序**逐个递归**，
  // 空子树自动换下一个候选——通用修复，非微信特判。
  std::stable_sort(kids.begin(), kids.end(), [](const KidItem& a, const KidItem& b) {
    return a.first.area() < b.first.area();
  });
  const wchar_t* maskNames[] = { L"MMUIRenderSubWindowHW", L"Chrome_RenderWidgetHostHWND" };
  IUIAutomationElement* fallback = nullptr;
  for (auto& kid : kids) {
    IUIAutomationElement* k = kid.second;
    bool isMask = false;
    std::wstring nm = name_of(k);
    for (auto* mn : maskNames) if (nm == mn) { isMask = true; break; }
    if (isMask) { k->Release(); continue; }
    IUIAutomationElement* d = drill_deepest_raw(auto_, k, pt, depthLeft - 1);
    if (d) {
      // kids 里除 k 外全部释放（含已留作 fallback 的），d 是新引用不在 kids 里
      for (auto& rest : kids) if (rest.second != k) rest.second->Release();
      return d;
    }
    if (!fallback) fallback = k; else k->Release();
  }
  // 所有候选都无更深：退回最小的非遮罩子元素本身（本轮终点）
  if (fallback) {
    SmartRect fr = rect_of(fallback);
    if (fr.area() < bestR.area()) return fallback;  // 所有权转移
    fallback->Release();
  }
  return nullptr;
}

// ── 目标窗定位：跳过本进程（全屏截图遮罩压在最上层）沿 z 序向下找第一个可见、含点的顶层窗 ──
// 2026-09-17 诊断：此前 WindowFromPoint 命中自己就放弃，UIA 也钻进自己页面 → 应用内恒空。
static bool is_own_process_hwnd(HWND h) {
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  return pid == GetCurrentProcessId();
}

static bool hwnd_rect(HWND h, SmartRect& out) {
  RECT rc{};
  if (!GetWindowRect(h, &rc) || rc.right <= rc.left || rc.bottom <= rc.top) return false;
  out.left = rc.left; out.top = rc.top; out.right = rc.right; out.bottom = rc.bottom;
  return true;
}

static HWND find_target_window(POINT pt) {
  HWND h = WindowFromPoint(pt);
  if (!h) h = GetTopWindow(nullptr);
  for (int i = 0; i < 128 && h; i++) {
    HWND root = GetAncestor(h, GA_ROOT);
    if (!root) root = GetAncestor(h, GA_ROOTOWNER);
    if (!root) root = h;
    SmartRect r{};
    if (IsWindowVisible(root) && !is_own_process_hwnd(root) && hwnd_rect(root, r)
        && r.contains(pt.x, pt.y, 0) && r.width() >= 80 && r.height() >= 60) {
      return root;
    }
    h = GetWindow(root, GW_HWNDNEXT);
  }
  return nullptr;
}

// ── 按需无障碍树激活 ────────────────────────────────────────────────
// 微信 4.x 等自绘框架默认只暴露"瘦身树"（只有窗/面板级元素，无会话列表条目），
// 检测到屏幕阅读器/无障碍客户端后才构建完整 UIA 树。Shotera 能框中微信会话行、
// 我们不能的差异就在这里：它查询前先走 MSAA 通道（AccessibleObjectFromWindow，
// 内部即 WM_GETOBJECT/OBJID_CLIENT）唤醒目标。这里对目标窗及其渲染子窗发两种
// 激活戳：OBJID_CLIENT（MSAA 客户端通道）与 UiaRootObjectId（UIA 根请求）。
#ifndef OBJID_CLIENT
#define OBJID_CLIENT 0xFFFFFFFC
#endif
#ifndef UiaRootObjectId
#define UiaRootObjectId 0x25
#endif

static HWND g_pokedRoot = nullptr;
static DWORD g_pokedTick = 0;
static HWND g_waitedRoot = nullptr;  // 首戳等待重查只做一次/根窗，避免永未激活的应用每 1.5s 卡一次

static void poke_hwnd(HWND h) {
  LRESULT res = 0;
  SendMessageTimeoutW(h, WM_GETOBJECT, 0, (LPARAM)OBJID_CLIENT,
                      SMTO_ABORTIFHUNG, 60, (PDWORD_PTR)&res);
  SendMessageTimeoutW(h, WM_GETOBJECT, 0, (LPARAM)UiaRootObjectId,
                      SMTO_ABORTIFHUNG, 60, (PDWORD_PTR)&res);
}

static void poke_accessibility(HWND root) {
  if (!root || !IsWindow(root)) return;
  poke_hwnd(root);
  // 渲染子窗（Chromium 的 Chrome_RenderWidgetHostHWND、微信的 MMUIRenderSubWindowHW）
  // 常持独立 provider：前两层可见子窗各戳一次，封顶 16 个控制耗时。
  struct Candidate { HWND h; int prio; };
  Candidate list[16];
  int n = 0;
  auto push = [&](HWND h, int prio) {
    if (n >= 16 || !h) return;
    // 懒加载渲染子窗即使不可见也收（微信弹出的聊天小窗 MMUIRenderSubWindowHW 隐藏挂
    // provider，跳过可见性过滤才能戳醒；对隐藏窗发 WM_GETOBJECT 无副作用）
    if (!IsWindowVisible(h) && prio != 0) return;
    for (int i = 0; i < n; i++) if (list[i].h == h) return;
    list[n].h = h; list[n].prio = prio; n++;
  };
  const wchar_t* lazyClasses[] = {
    L"Chrome_RenderWidgetHostHWND", L"Chrome_WidgetWin_0", L"Chrome_WidgetWin_1",
    L"MMUIRenderSubWindowHW", L"MozillaWindowClass",
  };
  HWND child = FindWindowExW(root, nullptr, nullptr, nullptr);
  for (int i = 0; i < 24 && child; i++) {
    int prio = 1;
    wchar_t cls[64] = {};
    GetClassNameW(child, cls, 64);
    for (auto* lc : lazyClasses) if (wcscmp(cls, lc) == 0) { prio = 0; break; }
    push(child, prio);
    HWND sub = FindWindowExW(child, nullptr, nullptr, nullptr);
    for (int j = 0; j < 8 && sub; j++) { push(sub, 1); sub = FindWindowExW(child, sub, nullptr, nullptr); }
    child = FindWindowExW(root, child, nullptr, nullptr);
  }
  // 高优先（渲染子窗）先戳
  for (int p = 0; p <= 1; p++)
    for (int i = 0; i < n; i++)
      if (list[i].prio == p) poke_hwnd(list[i].h);
}

static bool element_in_own_process(IUIAutomationElement* el) {
  if (!el) return true;
  int pid = 0;
  if (FAILED(el->get_CurrentProcessId(&pid))) return false;
  return (DWORD)pid == GetCurrentProcessId();
}

// 覆盖整个虚拟屏的元素（桌面/根）不进层级链；主窗本身由 window 字段单独返回
static bool covers_virtual_screen(const SmartRect& r) {
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (vw <= 0 || vh <= 0) return r.width() > 2400 && r.height() > 1400;
  return r.width() >= vw && r.height() >= vh;
}

// 扫描模式：逐层钻取在该窗必然停摆（微信列表虚拟化等）的窗口，记住后直接走
// 单发全子树批量扫描——COM 调用从 ~40 次降到 ~3 次/查询，移动中回包才跟得上光标。
static std::unordered_set<HWND> g_sweepHwnds;

// 批量扫描：一发 FindAll(Descendants) + 纯数据筛选——"含光标的最小元素"与
// 按几何包含推出的全部祖先层级（无需 14 次上溯导航）。子树过大（浏览器大文档）
// 返回 false，不切入扫描模式。
static bool collect_sweep_levels(IUIAutomationElement* root, POINT pt, std::vector<Level>& levels) {
  if (!g_automation || !g_propsCache || !root) return false;
  IUIAutomationCondition* cond = nullptr;
  if (FAILED(g_automation->CreateTrueCondition(&cond)) || !cond) return false;
  IUIAutomationElementArray* arr = nullptr;
  g_drillBudget -= 50;
  HRESULT hr = root->FindAllBuildCache(TreeScope_Descendants, cond, g_propsCache, &arr);
  cond->Release();
  if (FAILED(hr) || !arr) return false;
  int n = 0;
  arr->get_Length(&n);
  bool cheap = n <= 400;
  if (cheap) {
    for (int i = 0; i < n; i++) {
      IUIAutomationElement* c = nullptr;
      arr->GetElement(i, &c);
      if (!c) continue;
      SmartRect r = rect_of(c);
      if (r.width() >= 8 && r.height() >= 8 && r.contains(pt.x, pt.y, 1)
          && !covers_virtual_screen(r) && !is_offscreen(c)) {
        Level lv;
        lv.r = r;
        lv.name = name_of(c);
        lv.controlType = type_of(c);
        levels.push_back(lv);
      }
      c->Release();
    }
    // 根窗自身（Descendants 不含 self），保证层级链顶端有窗级
    SmartRect rr = rect_of(root);
    if (rr.width() >= 8 && rr.height() >= 8 && rr.contains(pt.x, pt.y, 1) && !covers_virtual_screen(rr)) {
      Level lv;
      lv.r = rr;
      lv.name = name_of(root);
      lv.controlType = type_of(root);
      levels.push_back(lv);
    }
  }
  arr->Release();
  return cheap;
}

// UIA 层级采集：起点 ElementFromPoint（须非本进程），否则从目标窗 ElementFromHandle 按点钻取
// forceHandle=true 跳过 ElementFromPoint（调试导出用：模拟应用内"点被自家遮罩挡住"的路径）
static void collect_uia_levels(POINT pt, HWND target, std::vector<Level>& levels, bool forceHandle = false) {
  IUIAutomationElement* el = nullptr;
  if (!forceHandle) {
    // 应用内光标处必是我们的全屏遮罩：EFP 只会命中自己（还顺带触发自家 Chromium a11y 命中测试，
    // 每帧白费 1-2 次跨进程调用），先用本地 Win32 判_own_再决定是否值得发起 EFP。
    HWND wfp = WindowFromPoint(pt);
    if (!(wfp && is_own_process_hwnd(wfp))) {
      HRESULT hr = g_automation->ElementFromPoint(pt, &el);
      if (SUCCEEDED(hr) && el && element_in_own_process(el)) {
        el->Release();
        el = nullptr;
      }
    }
  }
  if (!el && target) {
    g_automation->ElementFromHandle(target, &el);
    if (el && element_in_own_process(el)) {
      el->Release();
      el = nullptr;
    }
  }
  if (!el) return;

  // 扫描模式：该窗已证明钻取必停摆，直接单发批量扫描（~3 次跨进程调用），快路径
  if (target && g_propsCache && g_sweepHwnds.count(target) > 0) {
    collect_sweep_levels(el, pt, levels);
    el->Release();
    return;
  }

  IUIAutomationTreeWalker* walker = nullptr;
  g_automation->get_RawViewWalker(&walker);

  IUIAutomationElement* deep = el;
  deep->AddRef();
  SmartRect rr = rect_of(deep);
  // 深度 14：微信会话列表行自 HWND 根下探需 10+ 层（Group→Custom→…→List→ListItem，
  // 左侧导航按钮仅 4~5 层——此前 6 层的深度就是"导航图标能框、列表行框不到"的原因）；
  // 上溯链同为 14，两端对称。g_drillBudget 兜底防爆炸。
  if (rr.width() > 300 || rr.height() > 200) {
    IUIAutomationElement* drilled = drill_deepest_raw(g_automation, deep, pt, 14);
    if (drilled) {
      deep->Release();
      deep = drilled;
    }
  }

  // 兜底：逐层钻取仍停在大元素时（微信列表虚拟化——列表容器的行子元素按需暴露/矩形滞后，
  // 逐层 Children 枚举拿不到行；而 FindAll(Descendants) 全子树批量查询实测一发返回全部
  // 行元素，163 个后代几毫秒），从子树根做一次批量扫描，按数据挑"含光标的最小元素"。
  SmartRect winR{};
  bool haveWinR = target && hwnd_rect(target, winR);
  SmartRect deepR = rect_of(deep);
  long stallArea = deepR.area();
  long winArea = haveWinR ? winR.area() : 0;
  if (winArea > 0 && stallArea > winArea / 8 && g_propsCache) {
    IUIAutomationCondition* cond = nullptr;
    if (SUCCEEDED(g_automation->CreateTrueCondition(&cond)) && cond) {
      IUIAutomationElementArray* arr = nullptr;
      g_drillBudget -= 50;
      if (SUCCEEDED(el->FindAllBuildCache(TreeScope_Descendants, cond, g_propsCache, &arr)) && arr) {
          int n = 0;
          arr->get_Length(&n);
          if (n > 512) n = 512;
          IUIAutomationElement* best = nullptr;
          SmartRect bestR = deepR;
          for (int i = 0; i < n; i++) {
            IUIAutomationElement* c = nullptr;
            arr->GetElement(i, &c);
            if (!c) continue;
            SmartRect cr = rect_of(c);
            if (cr.width() >= 8 && cr.height() >= 8 && cr.contains(pt.x, pt.y, 1)
                && cr.area() < bestR.area() && !is_offscreen(c)) {
              if (best) best->Release();
              best = c;
              bestR = cr;
            } else {
              c->Release();
            }
          }
          if (best) {
            deep->Release();
            deep = best;
          }
          arr->Release();
          // 子树不大 → 该窗切入扫描模式（下一帧起走 ~3 次调用的快路径）
          if (target && n <= 400) g_sweepHwnds.insert(target);
        }
      cond->Release();
    }
  }

  // 不含光标则上溯（BuildCache 变体：属性随层级导航带回）
  for (int i = 0; i < 6; i++) {
    if (rect_of(deep).contains(pt.x, pt.y, 1)) break;
    IUIAutomationElement* parent = nullptr;
    if (walker) {
      if (g_propsCache) walker->GetParentElementBuildCache(deep, g_propsCache, &parent);
      else walker->GetParentElement(deep, &parent);
    }
    if (!parent) break;
    deep->Release();
    deep = parent;
  }

  // 收集层级链（RawView 上溯）；碰到本进程元素即停。
  // 8 层封顶：滚轮层级够用，且每层是 1-2 次跨进程调用——14 层的链路耗时是 EFP 延迟大头
  IUIAutomationElement* cur = deep;
  cur->AddRef();
  for (int depth = 0; depth < 8 && cur; depth++) {
    if (element_in_own_process(cur)) break;
    SmartRect r = rect_of(cur);
    if (r.width() >= 8 && r.height() >= 8 && r.contains(pt.x, pt.y, 2)
        && !covers_virtual_screen(r) && !is_offscreen(cur)) {
      Level lv;
      lv.r = r;
      lv.name = name_of(cur);
      lv.controlType = type_of(cur);
      levels.push_back(lv);
    }
    if (!walker) break;
    IUIAutomationElement* parent = nullptr;
    if (g_propsCache) walker->GetParentElementBuildCache(cur, g_propsCache, &parent);
    else walker->GetParentElement(cur, &parent);
    cur->Release();
    cur = parent;
  }
  if (cur) cur->Release();
  deep->Release();
  el->Release();
  if (walker) walker->Release();
}

// 导出
extern "C" __declspec(dllexport)
int SmartUiaGetLevels(int physX, int physY, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  if (!g_automation) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"uia-init\"}");
    return (int)strlen(outJson);
  }

  POINT pt = { physX, physY };
  std::vector<Level> levels;

  // Win32 目标顶层窗（跳过本进程）
  HWND target = find_target_window(pt);

  // 激活戳：每窗每会话一次（不再周期重发——疑似干扰微信虚拟化列表的树稳定性，导致行元素
  // 在相邻查询间出现/消失、框在行/面板间频闪）。微信等按需树首戳后异步构建（实测 ~100-250ms），
  // 首戳若仍只有窗级元素，稍候在同一调用内重查一次。
  bool pokedNow = false;
  if (target && target != g_pokedRoot) {
    poke_accessibility(target);
    g_pokedRoot = target;
    g_pokedTick = GetTickCount();
    pokedNow = true;
  }

  // Chromium 类应用的无障碍树在首次 UIA 查询后才异步激活（实测 Edge 需 ~100-250ms，且按应用生命周期
  // 只发生一次：1699×841 整页 → 1107×726 播放器）。同一调用内重查拿不到更深结果，靠悬停逐帧重查自然收敛。
  g_drillBudget = 250;
  collect_uia_levels(pt, target, levels);
  if (pokedNow && levels.size() <= 1 && target != g_waitedRoot) {
    g_waitedRoot = target;
    Sleep(140);
    g_drillBudget = 250;
    std::vector<Level> retry;
    collect_uia_levels(pt, target, retry);
    if (retry.size() > levels.size()) levels.swap(retry);
  }

  // Win32 顶层窗（已跳过本进程）
  std::wstring winTitle;
  SmartRect winRect{};
  bool winOk = false;
  if (target && hwnd_rect(target, winRect) && winRect.contains(pt.x, pt.y, 4)) {
    wchar_t title[256] = {0};
    GetWindowTextW(target, title, 255);
    winTitle = title;
    winOk = true;
  }

  std::sort(levels.begin(), levels.end(), [](const Level& a, const Level& b) {
    return a.r.area() < b.r.area();
  });
  // 去重：与上一层四边都在 2px 内的重复矩形丢掉（滚轮切层每步都要有可见变化）
  {
    std::vector<Level> dedup;
    for (const Level& lv : levels) {
      if (!dedup.empty()) {
        const SmartRect& p = dedup.back().r;
        if (std::abs(p.left - lv.r.left) <= 2 && std::abs(p.top - lv.r.top) <= 2
            && std::abs(p.right - lv.r.right) <= 2 && std::abs(p.bottom - lv.r.bottom) <= 2) {
          continue;
        }
      }
      dedup.push_back(lv);
    }
    levels.swap(dedup);
  }

  std::string json = "{\"ok\":true,\"levels\":[";
  for (size_t i = 0; i < levels.size(); i++) {
    const Level& lv = levels[i];
    // 名字截断：长消息预览会撑爆 item 缓冲截断 JSON（见 SnapshotByHwnd 注释）
    const std::string nameJson = json_escape(narrow(lv.name)).substr(0, 96);
    char item[512];
    snprintf(item, sizeof(item),
             "%s{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"%s\"}",
             i ? "," : "",
             lv.r.left, lv.r.top, lv.r.width(), lv.r.height(),
             nameJson.c_str(),
             lv.controlType.c_str());
    json += item;
  }
  json += "],\"window\":";
  if (winOk) {
    char wbuf[320];
    snprintf(wbuf, sizeof(wbuf),
             "{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"Window\"}",
             winRect.left, winRect.top, winRect.width(), winRect.height(),
             json_escape(narrow(winTitle)).c_str());
    json += wbuf;
  } else {
    json += "null";
  }
  json += "}";

  if ((int)json.size() >= outCap) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"overflow\"}");
    return (int)strlen(outJson);
  }
  memcpy(outJson, json.c_str(), json.size() + 1);
  return (int)json.size();
}

// 调试导出：绕过 z 序定位，直接指定目标 HWND 走 poke + ElementFromHandle 钻取（与应用同款路径）。
// 用途：桌面窗口遮挡导致探测器打不到目标窗时，隔离验证钻取链路（微信诊断 2026-09-18）。
extern "C" __declspec(dllexport)
int SmartUiaProbeHwnd(int64_t hwnd, int physX, int physY, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  if (!g_automation) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"uia-init\"}");
    return (int)strlen(outJson);
  }
  POINT pt = { physX, physY };
  HWND target = (HWND)(uintptr_t)hwnd;
  if (!IsWindow(target)) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"bad-hwnd\"}");
    return (int)strlen(outJson);
  }
  poke_accessibility(target);
  std::vector<Level> levels;
  g_drillBudget = 250;
  collect_uia_levels(pt, target, levels, true);
  if (levels.size() <= 1) {
    Sleep(200);
    g_drillBudget = 250;
    std::vector<Level> retry;
    collect_uia_levels(pt, target, retry, true);
    if (retry.size() > levels.size()) levels.swap(retry);
  }
  std::sort(levels.begin(), levels.end(), [](const Level& a, const Level& b) {
    return a.r.area() < b.r.area();
  });
  std::string json = "{\"ok\":true,\"levels\":[";
  for (size_t i = 0; i < levels.size(); i++) {
    const Level& lv = levels[i];
    // 名字截断：长消息预览会撑爆 item 缓冲截断 JSON（见 SnapshotByHwnd 注释）
    const std::string nameJson = json_escape(narrow(lv.name)).substr(0, 96);
    char item[512];
    snprintf(item, sizeof(item),
             "%s{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"%s\"}",
             i ? "," : "",
             lv.r.left, lv.r.top, lv.r.width(), lv.r.height(),
             nameJson.c_str(),
             lv.controlType.c_str());
    json += item;
  }
  json += "]}";
  if ((int)json.size() >= outCap) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"overflow\"}");
    return (int)strlen(outJson);
  }
  memcpy(outJson, json.c_str(), json.size() + 1);
  return (int)json.size();
}

// ══ MSAA 权威命中测试（Shotera 逐帧命中机制）════════════════════════
// AccessibleObjectFromWindow + accHitTest：由目标应用自己返回"这个点上最深层的元素"，
// 永远新鲜、永远最小——没有快照滞后，路径上不会出现"缺口处跳大容器"。单次 5-20ms。
static bool acc_get_rect(IAccessible* acc, VARIANT child, SmartRect& out) {
  long l = 0, t = 0, w = 0, h = 0;
  if (SUCCEEDED(acc->accLocation(&l, &t, &w, &h, child)) && w > 0 && h > 0) {
    out.left = l; out.top = t; out.right = l + w; out.bottom = t + h;
    return true;
  }
  return false;
}

static std::wstring acc_get_name(IAccessible* acc, VARIANT child) {
  BSTR b = nullptr;
  if (SUCCEEDED(acc->get_accName(child, &b)) && b) {
    std::wstring s(b, SysStringLen(b));
    SysFreeString(b);
    return s;
  }
  return L"";
}

static std::string acc_role_name(IAccessible* acc, VARIANT child) {
  VARIANT v;
  VariantInit(&v);
  std::string out = "Control";
  if (FAILED(acc->get_accRole(child, &v)) || v.vt != VT_I4) { VariantClear(&v); return out; }
  long r = v.lVal;
  VariantClear(&v);
  switch (r) {
    case 0x02: return "Menu";         // ROLE_SYSTEM_MENUBAR
    case 0x08: return "List";         // ROLE_SYSTEM_LIST
    case 0x09: return "Window";       // ROLE_SYSTEM_CLIENT
    case 0x0b: return "Edit";         // ROLE_SYSTEM_TEXT
    case 0x0c: return "CheckBox";     // ROLE_SYSTEM_CHECKBUTTON
    case 0x0e: return "MenuItem";     // ROLE_SYSTEM_MENUPOPUP
    case 0x10: return "Pane";         // ROLE_SYSTEM_PANE
    case 0x12: return "Pane";         // ROLE_SYSTEM_CLIENT fallback
    case 0x18: return "Group";        // ROLE_SYSTEM_GROUPING
    case 0x1e: return "Toolbar";      // ROLE_SYSTEM_TOOLBAR
    case 0x20: return "Text";         // ROLE_SYSTEM_STATICTEXT
    case 0x21: return "ListItem";     // ROLE_SYSTEM_LISTITEM
    case 0x22: return "Edit";         // ROLE_SYSTEM_EDITABLETEXT
    case 0x28: return "Window";       // ROLE_SYSTEM_WINDOW
    case 0x2a: return "Button";       // ROLE_SYSTEM_PUSHBUTTON
    case 0x2f: return "MenuItem";     // ROLE_SYSTEM_MENUITEM
    default: return "Control";
  }
}

// accHitTest 递归深挖至最深层元素（provider 自己的命中测试，权威且新鲜）
static IAccessible* acc_hit_deep(IAccessible* acc, POINT pt, int depth) {
  VARIANT v;
  VariantInit(&v);
  HRESULT hr = acc->accHitTest(pt.x, pt.y, &v);
  if (FAILED(hr)) return nullptr;
  if (v.vt == VT_I4) { VariantClear(&v); return acc; }  // 同对象的子 id
  if (v.vt != VT_DISPATCH || !v.pdispVal) { VariantClear(&v); return nullptr; }
  IAccessible* child = nullptr;
  bool got = SUCCEEDED(v.pdispVal->QueryInterface(IID_IAccessible, (void**)&child));
  VariantClear(&v);
  if (!got || !child) return nullptr;
  if (depth <= 0) return child;
  IAccessible* deeper = acc_hit_deep(child, pt, depth - 1);
  if (deeper) { child->Release(); return deeper; }
  return child;
}

// 逐帧命中：accHitTest 深挖 → accParent 上溯收集层级链（与 SmartUiaGetLevels 同构输出）
extern "C" __declspec(dllexport)
int SmartUiaHitLevels(int physX, int physY, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  if (!g_automation) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"uia-init\"}");
    return (int)strlen(outJson);
  }
  POINT pt = { physX, physY };
  HWND target = find_target_window(pt);
  if (!target) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"no-window\"}");
    return (int)strlen(outJson);
  }
  {
    DWORD nowTick = GetTickCount();
    if (target != g_pokedRoot || nowTick - g_pokedTick > 5000) {
      poke_accessibility(target);
      g_pokedRoot = target;
      g_pokedTick = nowTick;
    }
  }

  IAccessible* winAcc = nullptr;
  if (FAILED(AccessibleObjectFromWindow(target, OBJID_CLIENT, IID_IAccessible, (void**)&winAcc)) || !winAcc) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"a2w\"}");
    return (int)strlen(outJson);
  }
  IAccessible* deep = acc_hit_deep(winAcc, pt, 24);
  if (!deep) {
    winAcc->Release();
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"hittest\"}");
    return (int)strlen(outJson);
  }

  VARIANT self;
  VariantInit(&self);
  self.vt = VT_I4;
  self.lVal = CHILDID_SELF;

  std::vector<Level> levels;
  SmartRect winR{};
  const bool haveWin = hwnd_rect(target, winR);

  IUIAutomationTreeWalker* walker = nullptr;
  g_automation->get_RawViewWalker(&walker);  // 仅用于最终兜底，主链走 MSAA accParent

  IAccessible* cur = deep;
  cur->AddRef();
  int depthGuard = 0;
  while (cur && depthGuard++ < 14) {
    SmartRect r{};
    if (acc_get_rect(cur, self, r) && r.width() >= 8 && r.height() >= 8
        && r.contains(pt.x, pt.y, 2) && !covers_virtual_screen(r)) {
      // MSAA accLocation 偶发返回过期矩形：含光标即可信（provider 命中测试刚返回它）
      Level lv;
      lv.r = r;
      lv.name = acc_get_name(cur, self);
      lv.controlType = acc_role_name(cur, self);
      levels.push_back(lv);
    }
    IDispatch* parentDisp = nullptr;
    if (FAILED(cur->get_accParent(&parentDisp)) || !parentDisp) break;
    // accParent 返回 DISPATCH：QI 成 IAccessible（也可能就是本对象的父窗包装）
    IAccessible* parentAcc = nullptr;
    if (SUCCEEDED(parentDisp->QueryInterface(IID_IAccessible, (void**)&parentAcc))) {
      parentDisp->Release();
      cur->Release();
      cur = parentAcc;
    } else {
      parentDisp->Release();
      break;
    }
  }
  // MSAA 链顶端通常到窗 client 为止：补 Win32 窗级
  if (haveWin) {
    Level lv;
    lv.r = winR;
    wchar_t title[256] = { 0 };
    GetWindowTextW(target, title, 255);
    lv.name = title;
    lv.controlType = "Window";
    levels.push_back(lv);
  }

  std::sort(levels.begin(), levels.end(), [](const Level& a, const Level& b) {
    return a.r.area() < b.r.area();
  });

  std::string json = "{\"ok\":true,\"levels\":[";
  for (size_t i = 0; i < levels.size(); i++) {
    const Level& lv = levels[i];
    const std::string nameJson = json_escape(narrow(lv.name)).substr(0, 96);
    char item[512];
    snprintf(item, sizeof(item),
             "%s{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"%s\"}",
             i ? "," : "",
             lv.r.left, lv.r.top, lv.r.width(), lv.r.height(),
             nameJson.c_str(),
             lv.controlType.c_str());
    json += item;
  }
  json += "],\"window\":";
  if (haveWin) {
    char wbuf[320];
    wchar_t title[256] = { 0 };
    GetWindowTextW(target, title, 255);
    snprintf(wbuf, sizeof(wbuf),
             "{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"Window\"}",
             winR.left, winR.top, winR.width(), winR.height(),
             json_escape(narrow(title)).c_str());
    json += wbuf;
  } else {
    json += "null";
  }
  json += "}";
  if ((int)json.size() >= outCap) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"overflow\"}");
    return (int)strlen(outJson);
  }
  memcpy(outJson, json.c_str(), json.size() + 1);
  return (int)json.size();
}

// 调试导出：验证 UIA ElementFromPoint 是否跳过 WS_EX_TRANSPARENT 遮罩。
// 创建隐形 click-through 测试窗盖住 (x,y)，调 EFP，看返回的是测试窗还是下层应用。
// 全程不可见（alpha=0 + 无激活），验证完立即销毁。
extern "C" __declspec(dllexport)
int SmartEfpThroughTest(int physX, int physY, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  if (!g_automation) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"uia-init\"}");
    return (int)strlen(outJson);
  }
  const wchar_t* cls = L"PetalSnapEfpTestWnd";
  WNDCLASSW wc = {};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = cls;
  RegisterClassW(&wc);
  // 全屏铺满，click-through + alpha 0（完全不可见、不接收输入）
  HWND test = CreateWindowExW(
      WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
      cls, L"", WS_POPUP,
      GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
      GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN),
      nullptr, nullptr, wc.hInstance, nullptr);
  if (!test) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"create\"}");
    return (int)strlen(outJson);
  }
  SetLayeredWindowAttributes(test, 0, 0, LWA_ALPHA);
  ShowWindow(test, SW_SHOWNOACTIVATE);

  POINT pt = { physX, physY };
  IUIAutomationElement* el = nullptr;
  HRESULT hr = g_automation->ElementFromPoint(pt, &el);
  int own = -1;
  SmartRect r{};
  if (SUCCEEDED(hr) && el) {
    own = element_in_own_process(el) ? 1 : 0;
    r = rect_of(el);
    el->Release();
  }
  DestroyWindow(test);
  UnregisterClassW(cls, wc.hInstance);

  snprintf(outJson, outCap,
           "{\"ok\":true,\"own\":%d,\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}",
           own, r.left, r.top, r.width(), r.height());
  return (int)strlen(outJson);
}

// 全子树快照：一发 FindAll(Descendants) 导出目标窗全部后代元素（含窗自身）。
// 配合宿主侧"本地命中测试"——每 1.2s 一次快照 + 每帧纯本地挑框，跨进程调用
// 与悬停帧率彻底解耦（微信 Qt provider 单次扫描 ~200ms，逐帧查永远做不到跟手）。
static int SnapshotByHwnd(HWND target, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  if (!g_automation || !g_propsCache) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"uia-init\"}");
    return (int)strlen(outJson);
  }
  if (!target || !IsWindow(target)) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"no-window\"}");
    return (int)strlen(outJson);
  }
  // 激活戳同窗 5s 一次（16 窗×2 条 WM_GETOBJECT 的开销不必每拍都付；worker 高频查询
  // 本身就是持续在线的无障碍客户端）
  {
    DWORD nowTick = GetTickCount();
    if (target != g_pokedRoot || nowTick - g_pokedTick > 5000) {
      poke_accessibility(target);
      g_pokedRoot = target;
      g_pokedTick = nowTick;
    }
  }

  SmartRect winR{};
  if (!hwnd_rect(target, winR)) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"no-rect\"}");
    return (int)strlen(outJson);
  }

  IUIAutomationElement* root = nullptr;
  if (FAILED(g_automation->ElementFromHandle(target, &root)) || !root) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"efh\"}");
    return (int)strlen(outJson);
  }
  if (element_in_own_process(root)) {
    root->Release();
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"own\"}");
    return (int)strlen(outJson);
  }

  IUIAutomationCondition* cond = nullptr;
  if (FAILED(g_automation->CreateTrueCondition(&cond)) || !cond) {
    root->Release();
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"cond\"}");
    return (int)strlen(outJson);
  }
  // 控件视图优先（剔除布局壳子，对齐 Shotera）；Qt/微信 provider 可能对 5 属性批量请求
  // 整体失败或全 false → 零/失败时软降级回 g_propsCache 无过滤。
  IUIAutomationElementArray* arr = nullptr;
  IUIAutomationCacheRequest* usedCache = (g_ctrlCache ? g_ctrlCache : g_propsCache);
  HRESULT hr = root->FindAllBuildCache(TreeScope_Descendants, cond, usedCache, &arr);
  if (SUCCEEDED(hr) && arr) {
    int nn = 0;
    arr->get_Length(&nn);
    if (nn == 0) {
      arr->Release();
      arr = nullptr;
      usedCache = g_propsCache;
      hr = root->FindAllBuildCache(TreeScope_Descendants, cond, usedCache, &arr);
    }
  } else if (g_ctrlCache) {
    usedCache = g_propsCache;
    hr = root->FindAllBuildCache(TreeScope_Descendants, cond, usedCache, &arr);
  }
  cond->Release();
  if (FAILED(hr) || !arr) {
    root->Release();
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"findall\"}");
    return (int)strlen(outJson);
  }
  const bool ctrlOk = (usedCache == g_ctrlCache);

  // 条目先收集（控件视图失败/全灭 → 软降级重查），再拼 JSON
  std::vector<Level> items;
  {
    IUIAutomationElementArray* a = arr;
    int n = 0;
    a->get_Length(&n);
    for (int i = 0; i < n && (int)items.size() < 400; i++) {
      IUIAutomationElement* c = nullptr;
      a->GetElement(i, &c);
      if (!c) continue;
      SmartRect r = rect_of(c);
      // 最小可见尺寸地板：UIA 树含插入符盒/占位微元素（实测 15x18 的空 Edit"。"、14x14 空 Box），
      // 框出来就是用户看到的"空白小点"。低于此地板的直接不进快照，命中时自然落到上层容器。
      if (r.width() >= 24 && r.height() >= 16 && !is_offscreen(c) && !covers_virtual_screen(r)
          && (!ctrlOk || is_control_element(c))) {
        Level lv;
        lv.r = r;
        lv.name = name_of(c);
        lv.controlType = type_of(c);
        items.push_back(lv);
      }
      c->Release();
    }
  }
  arr->Release();
  if (ctrlOk && items.empty()) {
    // provider 全报非控件（Qt 某些版本）：软降级重查（无过滤）
    IUIAutomationCacheRequest* c2 = g_propsCache;
    if (c2) {
      IUIAutomationCondition* cond2 = nullptr;
      if (SUCCEEDED(g_automation->CreateTrueCondition(&cond2)) && cond2) {
        IUIAutomationElementArray* arr2 = nullptr;
        if (SUCCEEDED(root->FindAllBuildCache(TreeScope_Descendants, cond2, c2, &arr2)) && arr2) {
          int n2 = 0;
          arr2->get_Length(&n2);
          for (int i = 0; i < n2 && (int)items.size() < 400; i++) {
            IUIAutomationElement* c = nullptr;
            arr2->GetElement(i, &c);
            if (!c) continue;
            SmartRect r = rect_of(c);
            if (r.width() >= 8 && r.height() >= 8 && !is_offscreen(c) && !covers_virtual_screen(r)) {
              Level lv;
              lv.r = r;
              lv.name = name_of(c);
              lv.controlType = type_of(c);
              items.push_back(lv);
            }
            c->Release();
          }
          arr2->Release();
        }
        cond2->Release();
      }
    }
  }
  // 窗名要在 Release 前取出（此前 Release 后仍用 name_of(root) 是 use-after-free，
  // 悬停快照一发即崩、整个进程退出——"应用反复掉/遮罩闪没"的真凶，2026-09-19）
  // 名字截断到 96 字节：消息预览可达 500+ 字符，384 字节 item 缓冲会把 JSON 字符串
  // 截断在引号中间 → 非法 JSON → worker JSON.parse 抛异常 → 快照判失败 → UIA 链空
  // （"微信时好时坏"的真凶：长消息的会话必坏，短内容会话正常，2026-09-19）
  const std::wstring rootName = name_of(root);
  const std::string rootNameJson = json_escape(narrow(rootName)).substr(0, 96);
  root->Release();

  std::string json = "{\"ok\":true,\"window\":{\"x\":";
  {
    char wbuf[300];
    snprintf(wbuf, sizeof(wbuf), "%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\"}",
             winR.left, winR.top, winR.width(), winR.height(),
             rootNameJson.c_str());
    json += wbuf;
  }
  json += ",\"items\":[";
  // 首项 = 窗自身（Descendants 不含 self），本地挑框在窗内任何位置都有兜底级
  {
    char item[384];
    snprintf(item, sizeof(item),
             "{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"Window\"}",
             winR.left, winR.top, winR.width(), winR.height(),
             rootNameJson.c_str());
    json += item;
  }
  for (const Level& lv : items) {
    const std::string nameJson = json_escape(narrow(lv.name)).substr(0, 96);
    char item[384];
    snprintf(item, sizeof(item),
             ",{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"name\":\"%s\",\"controlType\":\"%s\"}",
             lv.r.left, lv.r.top, lv.r.width(), lv.r.height(),
             nameJson.c_str(),
             lv.controlType.c_str());
    json += item;
  }
  json += "]}";
  if ((int)json.size() >= outCap) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"overflow\"}");
    return (int)strlen(outJson);
  }
  memcpy(outJson, json.c_str(), json.size() + 1);
  return (int)json.size();
}

// 应用入口：按光标点找目标窗（跳过本进程遮罩）再走同一快照体
extern "C" __declspec(dllexport)
int SmartUiaSnapshot(int physX, int physY, char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  ensure_com();
  POINT pt = { physX, physY };
  return SnapshotByHwnd(find_target_window(pt), outJson, outCap);
}

// 调试导出：按 HWND 直拍快照（后台诊断用，不依赖 z 序、不碰窗口）
extern "C" __declspec(dllexport)
int SmartUiaSnapshotHwnd(int64_t hwnd, int physX, int physY, char* outJson, int outCap) {
  return SnapshotByHwnd((HWND)(uintptr_t)hwnd, outJson, outCap);
}


BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(hModule);
  } else if (reason == DLL_PROCESS_DETACH) {
    if (g_propsCache) {
      g_propsCache->Release();
      g_propsCache = nullptr;
    }
    if (g_ctrlCache) {
      g_ctrlCache->Release();
      g_ctrlCache = nullptr;
    }
    if (g_automation) {
      g_automation->Release();
      g_automation = nullptr;
    }
    CoUninitialize();
  }
  return TRUE;
}

// ═══════════════════════════════════════════════════════════════════════════
// 像素矩形层级检测（Snipaste/微信同款路线，2026-09-17 方案见
// docs/智能选区-技术方案对比与像素检测方案.md §五）
//
//   SmartPixelFramePrepare  —— 每会话一次：主色提取 + 前景掩码 + 积分图（~30ms，离热路径）
//   SmartPixelDetectLevels  —— 每次悬停：间隙阶梯式 xy-cut，全部 O(1) 区间查询（<0.1ms）
//
// 层级定义：光标处的界面元素 = 以光标为内点、四边都对齐"前景间隙"的最小矩形；
// 间隙容差阶梯逐级放大 → 文字行 → 消息块 → 行/卡片 → 行组 → 面板块 → 大面板。
// 边界完全来自本帧像素，不依赖各应用的无障碍实现质量。
// ═══════════════════════════════════════════════════════════════════════════

struct PixelFrame {
  int w = 0, h = 0;
  std::vector<uint8_t> fg;            // w*h：1=前景（与主色差超阈）
  std::vector<uint32_t> integral;     // (w+1)*(h+1)：fg 积分图，O(1) 矩形前景计数
  std::vector<uint8_t> gmh;           // w*h：1=强垂直边界像素（|Δx| 梯度 ≥96，如 1px 描边/分隔线）
  std::vector<uint32_t> ihm;          // gmh 积分图：O(1) 求"某列在某行带上的强边占比"
  std::vector<uint8_t> gmv;           // w*h：1=强水平边界像素（|Δy| 梯度 ≥96）
  std::vector<uint32_t> ivm;          // gmv 积分图：O(1) 求"某行在某列带上的强边占比"
  uint8_t bg[3] = {255, 255, 255};    // 画面主色（背景）
};
static PixelFrame g_pf;

static inline bool fg_at(const PixelFrame& f, int x, int y) {
  return f.fg[(size_t)y * f.w + x] != 0;
}

// 1×1 积分图通用查询（闭区间坐标，须已裁进画面）
static inline uint32_t mask_sum(const uint32_t* I, size_t W1, int x, int y) {
  return I[(size_t)(y + 1) * W1 + (x + 1)] - I[(size_t)y * W1 + (x + 1)]
       - I[(size_t)(y + 1) * W1 + x] + I[(size_t)y * W1 + x];
}

// 矩形 [x0,x1]×[y0,y1] 内前景计数（闭区间），坐标须已裁进画面
static inline uint32_t fg_count(const PixelFrame& f, int x0, int y0, int x1, int y1) {
  const uint32_t* I = f.integral.data();
  const size_t W1 = (size_t)f.w + 1;
  x0 = std::max(x0, 0); y0 = std::max(y0, 0);
  x1 = std::min(x1, f.w - 1); y1 = std::min(y1, f.h - 1);
  if (x1 < x0 || y1 < y0) return 0;
  return I[(size_t)(y1 + 1) * W1 + (x1 + 1)] - I[(size_t)y0 * W1 + (x1 + 1)]
       - I[(size_t)(y1 + 1) * W1 + x0] + I[(size_t)y0 * W1 + x0];
}

static void pixel_frame_prepare(const uint8_t* rgba, int w, int h, int stride) {
  PixelFrame f;
  f.w = w; f.h = h;
  f.fg.resize((size_t)w * h);
  f.gmh.resize((size_t)w * h);
  f.gmv.resize((size_t)w * h);

  // 主色：32 级量化直方图的众数（画面背景通常占绝对多数）
  int hist[32][32][32] = {};
  for (int y = 0; y < h; y++) {
    const uint8_t* row = rgba + (size_t)y * stride;
    for (int x = 0; x < w; x++) {
      hist[row[x * 4] >> 3][row[x * 4 + 1] >> 3][row[x * 4 + 2] >> 3]++;
    }
  }
  int best = 0, br = 31, bgg = 31, bb = 31;
  for (int r = 0; r < 32; r++) for (int g = 0; g < 32; g++) for (int b = 0; b < 32; b++) {
    if (hist[r][g][b] > best) { best = hist[r][g][b]; br = r; bgg = g; bb = b; }
  }
  f.bg[0] = (uint8_t)(br * 8 + 4); f.bg[1] = (uint8_t)(bgg * 8 + 4); f.bg[2] = (uint8_t)(bb * 8 + 4);

  // 前景掩码：与主色的通道差和 > 90（约 30/255/通道）
  const int T = 90;
  for (int y = 0; y < h; y++) {
    const uint8_t* row = rgba + (size_t)y * stride;
    uint8_t* out = &f.fg[(size_t)y * w];
    for (int x = 0; x < w; x++) {
      int dr = row[x * 4] - f.bg[0], dg = row[x * 4 + 1] - f.bg[1], db = row[x * 4 + 2] - f.bg[2];
      out[x] = (std::abs(dr) + std::abs(dg) + std::abs(db)) > T ? 1 : 0;
    }
  }

  // 强边界掩码：相邻像素通道差和 ≥96（1px 描边/分隔线/色块突变；饱和到 255 防大图积分溢出）
  const int GE = 96;
  for (int y = 0; y < h; y++) {
    const uint8_t* row = rgba + (size_t)y * stride;
    for (int x = 0; x < w; x++) {
      int dh = 0, dv = 0;
      if (x > 0) {
        dh = std::abs(row[x * 4] - row[(x - 1) * 4]) + std::abs(row[x * 4 + 1] - row[(x - 1) * 4 + 1])
           + std::abs(row[x * 4 + 2] - row[(x - 1) * 4 + 2]);
      }
      if (y > 0) {
        const uint8_t* up = row - stride;
        dv = std::abs(row[x * 4] - up[x * 4]) + std::abs(row[x * 4 + 1] - up[x * 4 + 1])
           + std::abs(row[x * 4 + 2] - up[x * 4 + 2]);
      }
      f.gmh[(size_t)y * w + x] = (dh = std::min(dh, 255)) >= GE ? 1 : 0;
      f.gmv[(size_t)y * w + x] = (dv = std::min(dv, 255)) >= GE ? 1 : 0;
    }
  }

  // 三张积分图
  f.integral.assign((size_t)(w + 1) * (h + 1), 0);
  f.ihm.assign((size_t)(w + 1) * (h + 1), 0);
  f.ivm.assign((size_t)(w + 1) * (h + 1), 0);
  for (int y = 0; y < h; y++) {
    uint32_t sF = 0, sH = 0, sV = 0;
    const size_t off = (size_t)y * w;
    const uint32_t* pF = &f.integral[(size_t)y * (w + 1)];
    const uint32_t* pH = &f.ihm[(size_t)y * (w + 1)];
    const uint32_t* pV = &f.ivm[(size_t)y * (w + 1)];
    uint32_t* dF = &f.integral[(size_t)(y + 1) * (w + 1)];
    uint32_t* dH = &f.ihm[(size_t)(y + 1) * (w + 1)];
    uint32_t* dV = &f.ivm[(size_t)(y + 1) * (w + 1)];
    for (int x = 0; x < w; x++) {
      sF += f.fg[off + x]; sH += f.gmh[off + x]; sV += f.gmv[off + x];
      dF[x + 1] = pF[x + 1] + sF;
      dH[x + 1] = pH[x + 1] + sH;
      dV[x + 1] = pV[x + 1] + sV;
    }
  }

  g_pf = std::move(f);
}

// ── 边界吸附式层级检测（替换间隙阶梯，2026-09-17 §6.3 P1a）──
//
// 每条边独立扩展，停靠两类边界（先到先停）：
//   强边：该列/行在当前跨度上 ≥60% 是强边界像素（真实描边/分隔线/色块突变）→ 吸附到线上
//   静默带：连续 ≥ quietMin 行/列无前景（纯空白分隔）→ 停在最后内容行/列
// 逐级放宽 quietMin：静默停靠的边在下一级穿过更宽的空白带吸附到更外层的强边/内容，
// 形成「文字行 → 消息块 → 行/卡片 → 面板 → 大面板」的层级。强边薄带（1px）在行带/列带
// 足够宽（≥12）后才参与判定，避免 L0 细带上的噪声。

static inline int col_strong_ratio(const PixelFrame& f, int x, int t, int b) {
  if (b < t || x < 0 || x >= f.w) return 0;
  int n = 0;
  for (int y = t; y <= b; y++) n += mask_sum(f.ihm.data(), f.w + 1, x, y);
  return (n * 100) / (b - t + 1);
}
static inline int row_strong_ratio(const PixelFrame& f, int y, int l, int r) {
  if (r < l || y < 0 || y >= f.h) return 0;
  int n = 0;
  for (int x = l; x <= r; x++) n += mask_sum(f.ivm.data(), f.w + 1, x, y);
  return (n * 100) / (r - l + 1);
}

static void pixel_detect_levels(POINT pt, int bx, int by, int bw, int bh,
                                std::vector<Level>& levels) {
  const PixelFrame& f = g_pf;
  const int x0 = std::max(bx, 0), y0 = std::max(by, 0);
  const int x1 = std::min(bx + bw - 1, f.w - 1), y1 = std::min(by + bh - 1, f.h - 1);
  if (x1 <= x0 || y1 <= y0) return;
  int cx = pt.x, cy = pt.y;
  cx = std::max(x0, std::min(cx, x1));
  cy = std::max(y0, std::min(cy, y1));

  const double s = std::max(1.0, f.w / 1920.0);
  const int quietLadder[] = { (int)(3 * s), (int)(10 * s), (int)(22 * s),
                              (int)(44 * s), (int)(88 * s), (int)(176 * s) };
  const int nL = sizeof(quietLadder) / sizeof(quietLadder[0]);
  const int EDGE_RATIO = 60;     // 强边：跨度上 ≥60% 有强梯度
  const int BAND_MIN = 12;       // 跨度 <12 时强边不参与（细带噪声）

  int L = cx, R = cx, T = cy, B = cy;
  int lastL = -1, lastT = -1, lastR = -1, lastB = -1;

  for (int gi = 0; gi < nL; gi++) {
    const int q = quietLadder[gi];

    // 上下扩展：行强边（水平梯度，列带够宽才判）优先，其次静默带
    {
      const int wx0 = std::max(x0, L - q), wx1 = std::min(x1, R + q);
      const bool edgeOk = (wx1 - wx0) >= BAND_MIN;
      int empty = 0;
      for (int y = T - 1; y >= y0; y--) {
        uint32_t c = fg_count(f, wx0, y, wx1, y);
        if (c > 0) { T = y; empty = 0; continue; }
        if (edgeOk && row_strong_ratio(f, y, wx0, wx1) >= EDGE_RATIO) { T = y; break; }
        if (++empty > q) break;
      }
      empty = 0;
      for (int y = B + 1; y <= y1; y++) {
        uint32_t c = fg_count(f, wx0, y, wx1, y);
        if (c > 0) { B = y; empty = 0; continue; }
        if (edgeOk && row_strong_ratio(f, y, wx0, wx1) >= EDGE_RATIO) { B = y; break; }
        if (++empty > q) break;
      }
    }
    // 左右扩展：列强边（垂直梯度，行带够高才判）优先，其次静默带
    {
      const bool edgeOk = (B - T) >= BAND_MIN;
      int empty = 0;
      for (int x = L - 1; x >= x0; x--) {
        uint32_t c = fg_count(f, x, T, x, B);
        if (c > 0) { L = x; empty = 0; continue; }
        if (edgeOk && col_strong_ratio(f, x, T, B) >= EDGE_RATIO) { L = x; break; }
        if (++empty > q) break;
      }
      empty = 0;
      for (int x = R + 1; x <= x1; x++) {
        uint32_t c = fg_count(f, x, T, x, B);
        if (c > 0) { R = x; empty = 0; continue; }
        if (edgeOk && col_strong_ratio(f, x, T, B) >= EDGE_RATIO) { R = x; break; }
        if (++empty > q) break;
      }
    }

    const int pad = std::max(2, q / 8);
    int aL = std::max(x0, L - pad), aT = std::max(y0, T - pad);
    int aR = std::min(x1, R + pad), aB = std::min(y1, B + pad);
    if (cx < aL || cx > aR || cy < aT || cy > aB) continue;

    // 与上一级几乎相同 → 不成级，但保留扩展结果继续下一级
    if (aL <= lastL && aT <= lastT && aR >= lastR && aB >= lastB
        && (long long)(aR - aL) * (aB - aT) - (long long)(lastR - lastL) * (lastB - lastT) < 64) {
      continue;
    }
    if ((long long)(aR - aL) * (aB - aT) < 64) continue;

    Level lv;
    lv.r.left = aL; lv.r.top = aT; lv.r.right = aR; lv.r.bottom = aB;
    lv.name = L"";
    lv.controlType = gi == 0 ? "Text" : (gi == 1 ? "Block" : (gi == 2 ? "Item" : "Region"));
    levels.push_back(lv);
    lastL = aL; lastT = aT; lastR = aR; lastB = aB;
  }
}

extern "C" __declspec(dllexport)
int SmartPixelFramePrepare(const uint8_t* rgba, int w, int h, int stride) {
  if (!rgba || w < 64 || h < 64 || stride < w * 4) return -1;
  pixel_frame_prepare(rgba, w, h, stride);
  return 1;
}

extern "C" __declspec(dllexport)
int SmartPixelDetectLevels(int px, int py, int bx, int by, int bw, int bh,
                           char* outJson, int outCap) {
  if (!outJson || outCap < 64) return -1;
  if (!g_pf.w) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"no-frame\"}");
    return (int)strlen(outJson);
  }
  POINT pt = { px, py };
  std::vector<Level> levels;
  pixel_detect_levels(pt, bx, by, bw, bh, levels);

  std::string json = "{\"ok\":true,\"levels\":[";
  for (size_t i = 0; i < levels.size(); i++) {
    const Level& lv = levels[i];
    char item[256];
    snprintf(item, sizeof(item),
             "%s{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld,\"controlType\":\"%s\"}",
             i ? "," : "", lv.r.left, lv.r.top, lv.r.width(), lv.r.height(), lv.controlType.c_str());
    json += item;
  }
  json += "],\"window\":null}";
  if ((int)json.size() >= outCap) {
    snprintf(outJson, outCap, "{\"ok\":false,\"error\":\"overflow\"}");
    return (int)strlen(outJson);
  }
  memcpy(outJson, json.c_str(), json.size() + 1);
  return (int)json.size();
}
