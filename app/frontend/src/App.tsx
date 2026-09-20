import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import './app.css';

// ---------- Типы (совпадают с ответами бекенда) ----------
type Role = 'reader' | 'lock';
type DeviceStatus = 'pending' | 'approved' | 'blocked';
type Tab = 'control' | 'devices' | 'users' | 'logs';

interface Device {
  deviceId: string;
  name: string;
  role: Role | null;
  status: DeviceStatus;
  targets: string[];
  online: boolean;
  lastSeen: number;
}
interface UserRow {
  _id: string;
  user_id: string;
  name: string;
  accessLevel: string;
  startWorkDay: number;
  endWorkDay: number;
  totalWorkMs: number;
}
interface LogRow {
  _id: string;
  user_id: string;
  isEntry: boolean;
  access: boolean;
  reason: string;
  timestamp: string;
}
interface Paged<T> {
  data: T[];
  page: number;
  pages: number;
  total: number;
}
interface Limits {
  currentLimit: number;
  currentCounter: number;
  isLimitWorking: boolean;
}
interface Status {
  reader: boolean;
  lock: boolean;
  emergency: boolean;
  adding: boolean;
  limits: Limits;
}
type DevicePatch = Partial<Pick<Device, 'name' | 'role' | 'status' | 'targets'>>;

type Call = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Run = (action: () => Promise<unknown>, okText: string) => Promise<boolean>;
type Notify = (text: string, error?: boolean) => void;

// ---------- Настройки ----------
const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
// Лимитер бекенда: 100 запросов в минуту на IP в production. Опрос делает ~48 запросов в минуту.
const POLL_MS = 5000;
// Обновление таблиц (журнал, пользователи). Вкладка в фоне не опрашивается.
const LIVE_MS = 3000;
const PAGE_SIZE = 20;
const KEY_STORAGE = 'skud_admin_key';

const STATUS_LABEL: Record<DeviceStatus, string> = {
  pending: 'Ожидает одобрения',
  approved: 'Одобрено',
  blocked: 'Заблокировано',
};
const ROLE_LABEL: Record<Role, string> = { reader: 'Считыватель', lock: 'Замок' };
const REASON_LABEL: Record<string, string> = {
  ALLOWED: 'Проход разрешён',
  EMERGENCY: 'Открыто в режиме ЧС',
  DENIED_UNKNOWN: 'Карта не зарегистрирована',
  DENIED_LIMIT: 'Достигнут лимит людей',
  DENIED_SHIFT: 'Вне рабочей смены',
};

// ---------- Работа с API ----------
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Собирает читаемое сообщение из ответа бекенда: error + ошибки по полям
function apiMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const d = data as { error?: unknown; details?: unknown; formErrors?: unknown };
  const parts: string[] = [];
  if (d.error) parts.push(String(d.error));
  if (d.details && typeof d.details === 'object') {
    for (const [field, errs] of Object.entries(d.details as Record<string, unknown>)) {
      parts.push(`${field}: ${Array.isArray(errs) ? errs.join(', ') : String(errs)}`);
    }
  }
  if (Array.isArray(d.formErrors)) parts.push(...d.formErrors.map(String));
  return parts.join('; ') || fallback;
}

async function request<T>(path: string, key: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = parseJson(await res.text());
  if (!res.ok) throw new ApiError(res.status, apiMessage(data, res.statusText));
  return data as T;
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 401 ? 'Неверный ключ администратора' : e.message;
  if (e instanceof TypeError) return 'Нет связи с сервером';
  return e instanceof Error ? e.message : 'Неизвестная ошибка';
}

function usePolling(load: () => Promise<void>, ms: number) {
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && !document.hidden) void load();
    };
    tick();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick); // вернулись на вкладку: обновляем сразу
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load, ms]);
}

// Постраничный список с живым обновлением (журнал, пользователи)
function usePagedList<T>(call: Call, notify: Notify, path: string) {
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paged<T> | null>(null);
  const pageRef = useRef(page);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  const load = useCallback(
    async (silent = false) => {
      try {
        const res = await call<Paged<T>>(`${path}?page=${page}&limit=${PAGE_SIZE}`);
        if (pageRef.current !== page) return; // пока ждали ответ, страницу уже сменили
        if (res.data.length === 0 && page > 1) setPage(page - 1);
        else setList(res);
      } catch (e) {
        if (!silent) notify(errorText(e), true); // при фоновом опросе ошибки не показываем, статус связи виден в верхней полосе
      }
    },
    [call, notify, page, path],
  );

  const poll = useCallback(() => load(true), [load]);
  usePolling(poll, LIVE_MS);

  return { list, page, setPage, load };
}

const formatWork = (ms: number) => `${Math.floor(ms / 3_600_000)} ч ${Math.floor((ms % 3_600_000) / 60_000)} мин`;
const formatTime = (iso: string) => new Date(iso).toLocaleString('ru-RU');

// ---------- Корневой компонент ----------
export default function App() {
  const [key, setKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? '');

  const login = (k: string) => {
    sessionStorage.setItem(KEY_STORAGE, k);
    setKey(k);
  };
  const logout = useCallback(() => {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey('');
  }, []);

  return key ? <Panel adminKey={key} onLogout={logout} /> : <Login onLogin={login} />;
}

function Login({ onLogin }: { onLogin: (key: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request('/api/devices', value.trim()); // проверяем ключ реальным админским запросом
      onLogin(value.trim());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1>Панель СКУД</h1>
        <label className="field">
          <span>Ключ администратора</span>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !value.trim()}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}

// ---------- Основная панель ----------
function Panel({ adminKey, onLogout }: { adminKey: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('control');
  const [status, setStatus] = useState<Status | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [offline, setOffline] = useState(false);
  const [addingReader, setAddingReader] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const call: Call = useCallback(
    <T,>(path: string, method = 'GET', body?: unknown) => request<T>(path, adminKey, method, body),
    [adminKey],
  );
  const notify: Notify = useCallback((text, error = false) => setNotice({ text, error }), []);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // Состояние системы и устройства. Публичные роуты и админский /api/devices.
  const refresh = useCallback(async () => {
    try {
      const [conn, hw, add, limits, devs] = await Promise.all([
        call<{ connected: boolean; connectedLock: boolean }>('/api/connection-to-server'),
        call<{ isEmergency: boolean }>('/api/hardware-status'),
        call<{ isAddingCard: boolean }>('/api/adding-card'),
        // Пустое тело ничего не меняет и возвращает текущие лимит и счётчик.
        // Обходной путь: отдельного GET для счётчика на бекенде пока нет.
        call<Limits>('/api/set-users-limit', 'POST', {}),
        call<Device[]>('/api/devices'),
      ]);
      setStatus({ reader: conn.connected, lock: conn.connectedLock, emergency: hw.isEmergency, adding: add.isAddingCard, limits });
      setDevices(devs);
      setOffline(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onLogout();
      else if (!(e instanceof ApiError)) setOffline(true); // только сетевые сбои; 429/500 значит, что сервер отвечает
    }
  }, [call, onLogout]);
  usePolling(refresh, POLL_MS);

  // Выполняет действие, показывает результат и сразу обновляет состояние
  const run: Run = useCallback(
    async (action, okText) => {
      try {
        await action();
        notify(okText);
        void refresh();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onLogout();
        else notify(errorText(e), true);
        return false;
      }
    },
    [notify, refresh, onLogout],
  );

  const mode = offline ? 'offline' : status?.emergency ? 'emergency' : status?.adding ? 'adding' : 'normal';
  const addingName = devices.find((d) => d.deviceId === addingReader)?.name;
  const bandNote = {
    offline: 'Нет связи с сервером. Данные на экране могут быть устаревшими.',
    emergency: 'Режим ЧС: считыватели не принимают карты, устройства получили сигнал ЧС.',
    adding: `Идёт добавление карт${addingName ? ` на считывателе «${addingName}»` : ''}: приложенные карты регистрируются как новые пользователи.`,
    normal: 'Система работает в обычном режиме.',
  }[mode];
  const pending = devices.filter((d) => d.status === 'pending').length;

  return (
    <>
      <header className="band" data-mode={mode}>
        <div>
          <h1>
            Внутри: {status ? status.limits.currentCounter : '–'}
            {status?.limits.isLimitWorking ? ` из ${status.limits.currentLimit}` : ''}
          </h1>
          <p role="status">{bandNote}</p>
        </div>
        <div className="band-side">
          <ul className="links">
            <li data-on={Boolean(status?.reader)}>Считыватель: {status?.reader ? 'на связи' : 'нет связи'}</li>
            <li data-on={Boolean(status?.lock)}>Замок: {status?.lock ? 'на связи' : 'нет связи'}</li>
          </ul>
          <button className="btn btn-ghost" onClick={onLogout}>Выйти</button>
        </div>
      </header>

      <div className="shell">
        <nav className="menu" aria-label="Разделы">
          {(
            [
              ['control', 'Управление'],
              ['devices', 'Устройства'],
              ['users', 'Пользователи'],
              ['logs', 'Журнал'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}
              {id === 'devices' && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          ))}
        </nav>

        <main>
          {tab === 'control' && (
            <ControlTab status={status} devices={devices} call={call} run={run} notify={notify} onAddingReader={setAddingReader} />
          )}
          {tab === 'devices' && <DevicesTab devices={devices} call={call} run={run} />}
          {tab === 'users' && <UsersTab call={call} run={run} notify={notify} />}
          {tab === 'logs' && <LogsTab call={call} run={run} notify={notify} />}
        </main>
      </div>

      {notice && (
        <div className="notice" data-error={notice.error} role={notice.error ? 'alert' : 'status'}>
          {notice.text}
        </div>
      )}
    </>
  );
}

// ---------- Управление: ЧС, добавление карт, лимит ----------
function ControlTab(props: {
  status: Status | null;
  devices: Device[];
  call: Call;
  run: Run;
  notify: Notify;
  onAddingReader: (id: string | null) => void;
}) {
  const { status, devices, call, run, notify, onAddingReader } = props;
  const [readerId, setReaderId] = useState('');
  const [limit, setLimit] = useState('');
  const [counter, setCounter] = useState('');
  const readers = devices.filter((d) => d.role === 'reader' && d.status === 'approved');

  if (!status) return <p className="hint">Загружаем состояние…</p>;

  const toggleEmergency = () => {
    const next = !status.emergency;
    if (next && !window.confirm('Включить режим ЧС? Считыватели перестанут принимать карты, а устройства получат сигнал ЧС.')) return;
    void run(() => call('/api/emergency-situation', 'POST', { value: next }), next ? 'Режим ЧС включён' : 'Режим ЧС выключен');
  };

  const toggleAdding = () => {
    const next = !status.adding;
    const target = next && readerId ? readerId : null;
    void run(async () => {
      await call('/api/adding-card', 'POST', target ? { value: next, readerId: target } : { value: next });
      onAddingReader(target);
    }, next ? 'Добавление карт включено' : 'Добавление карт выключено');
  };

  const saveLimits = (e: FormEvent, resetCounter = false) => {
    e.preventDefault();
    const body: { usersLimitParam?: number; counterInUsersParam?: number } = {};
    if (limit !== '') body.usersLimitParam = Number(limit);
    if (resetCounter) body.counterInUsersParam = 0;
    else if (counter !== '') body.counterInUsersParam = Number(counter);
    if (Object.keys(body).length === 0) return notify('Введите новый лимит или значение счётчика', true);
    void run(() => call('/api/set-users-limit', 'POST', body), 'Лимит сохранён').then((ok) => {
      if (ok) {
        setLimit('');
        setCounter('');
      }
    });
  };

  return (
    <>
      <section className="block">
        <h2>Режим ЧС</h2>
        <p className="hint">Пока режим включён, считыватели не принимают карты, а одобренные устройства получают от сервера сигнал ЧС. Проходы в это время в журнал не попадают.</p>
        <button className={status.emergency ? 'btn btn-primary' : 'btn btn-danger'} aria-pressed={status.emergency} onClick={toggleEmergency}>
          {status.emergency ? 'Выключить режим ЧС' : 'Включить режим ЧС'}
        </button>
      </section>

      <section className="block">
        <h2>Добавление карт</h2>
        <p className="hint">Пока режим включён, каждая новая карта у считывателя регистрируется как пользователь с именем вида «Card 1234» по последним четырём символам номера.</p>
        <div className="fields">
          <label className="field">
            <span>Считыватель</span>
            <select value={readerId} onChange={(e) => setReaderId(e.target.value)} disabled={status.adding}>
              <option value="">Любой одобренный</option>
              {readers.map((r) => (
                <option key={r.deviceId} value={r.deviceId}>{r.name || r.deviceId}</option>
              ))}
            </select>
          </label>
          <div>
            <button className={status.adding ? 'btn btn-primary' : 'btn'} aria-pressed={status.adding} onClick={toggleAdding}>
              {status.adding ? 'Остановить добавление' : 'Начать добавление'}
            </button>
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Лимит людей</h2>
        <p className="hint">
          Сейчас внутри {status.limits.currentCounter}.{' '}
          {status.limits.isLimitWorking ? `Лимит ${status.limits.currentLimit}: при его достижении вход закрывается.` : 'Лимит выключен.'} Значение 0 отключает лимит.
        </p>
        <form className="fields" onSubmit={(e) => saveLimits(e)}>
          <label className="field">
            <span>Новый лимит</span>
            <input type="number" min={0} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <label className="field">
            <span>Поправить счётчик</span>
            <input type="number" min={0} step={1} value={counter} onChange={(e) => setCounter(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn btn-primary">Сохранить</button>
            <button type="button" className="btn" onClick={(e) => saveLimits(e, true)}>Обнулить счётчик</button>
          </div>
        </form>
      </section>
    </>
  );
}

// ---------- Устройства ----------
function DevicesTab({ devices, call, run }: { devices: Device[]; call: Call; run: Run }) {
  const rank: Record<DeviceStatus, number> = { pending: 0, approved: 1, blocked: 2 };
  const sorted = [...devices].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  const locks = devices.filter((d) => d.role === 'lock');
  const url = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

  return (
    <section className="block">
      <h2>Устройства</h2>
      <p className="hint">Новая плата появляется здесь сама, как только подключится к брокеру. Одобрите её и задайте роль, и она начнёт работать без изменений в коде.</p>
      {sorted.length === 0 && <p className="empty">Устройств пока нет. Включите ESP32: она сама появится здесь со статусом «Ожидает одобрения».</p>}
      {sorted.map((d) => (
        <DeviceRow
          key={d.deviceId}
          device={d}
          locks={locks}
          save={(patch) => void run(() => call(url(d.deviceId), 'PATCH', patch), 'Устройство сохранено')}
          rename={(name) => void run(() => call(url(d.deviceId), 'PATCH', { name }), 'Название сохранено')}
          remove={() => {
            if (window.confirm('Удалить устройство? Если оно включено, оно появится снова как новое.')) {
              void run(() => call(url(d.deviceId), 'DELETE'), 'Устройство удалено');
            }
          }}
        />
      ))}
    </section>
  );
}

function DeviceRow(props: {
  device: Device;
  locks: Device[];
  save: (patch: DevicePatch) => void;
  rename: (name: string) => void;
  remove: () => void;
}) {
  const { device, locks, save, rename, remove } = props;
  const [open, setOpen] = useState(device.status === 'pending');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const [role, setRole] = useState<Role | ''>(device.role ?? '');
  const [targets, setTargets] = useState<string[]>(device.targets);

  const patch = (status?: DeviceStatus): DevicePatch => ({
    ...(role ? { role } : {}),
    targets: role === 'reader' ? targets : [],
    ...(status ? { status } : {}),
  });
  const toggleTarget = (id: string) => setTargets((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const startRename = () => {
    setDraft(device.name || device.deviceId);
    setEditing(true);
  };
  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (next && next !== device.name) rename(next);
    setEditing(false);
  };
  const targetNames = device.targets.map((id) => locks.find((l) => l.deviceId === id)?.name || id);

  return (
    <div className="device">
      <div className="device-head">
        {editing ? (
          <form className="rename" onSubmit={submitRename}>
            <input
              aria-label="Новое название устройства"
              value={draft}
              maxLength={100}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            />
            <button className="btn btn-small btn-primary" disabled={!draft.trim()}>Сохранить</button>
            <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>Отмена</button>
          </form>
        ) : (
          <div className="device-name">
            <span className="device-title">{device.name || device.deviceId}</span>
            <button className="btn btn-small" onClick={startRename}>Переименовать</button>
            <button className="btn btn-small" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Скрыть настройки' : 'Настройки'}
            </button>
          </div>
        )}
        <span className="device-meta" data-online={device.online}>
          {device.role ? ROLE_LABEL[device.role] : 'Роль не задана'}, {device.online ? 'на связи' : 'нет связи'}
        </span>
        <span className={`pill pill-${device.status}`}>{STATUS_LABEL[device.status]}</span>
      </div>

      {device.role === 'reader' && (
        <div className="route">
          {targetNames.length > 0 ? (
            <>
              <span className="route-line" aria-hidden="true" />
              <span className="visually-hidden">Открывает:</span>
              {targetNames.map((n) => <span className="route-chip" key={n}>{n}</span>)}
            </>
          ) : (
            <span className="hint">Замок не выбран: считыватель никого не пропустит.</span>
          )}
        </div>
      )}

      {open && (
        <div className="device-body">
          <div className="fields">
            <label className="field">
              <span>Роль</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role | '')}>
                <option value="">Не выбрана</option>
                <option value="reader">Считыватель</option>
                <option value="lock">Замок</option>
              </select>
            </label>
          </div>

          {role === 'reader' && (
            <fieldset className="checks">
              <legend>Какие замки открывает</legend>
              {locks.length > 0 ? (
                locks.map((l) => (
                  <label key={l.deviceId}>
                    <input type="checkbox" checked={targets.includes(l.deviceId)} onChange={() => toggleTarget(l.deviceId)} /> {l.name || l.deviceId}
                  </label>
                ))
              ) : (
                <p className="hint">Сначала добавьте устройство с ролью «Замок».</p>
              )}
            </fieldset>
          )}

          <p className="hint">Идентификатор: {device.deviceId}</p>
          <div className="actions">
            {device.status === 'approved' ? (
              <>
                <button className="btn btn-primary" onClick={() => save(patch())}>Сохранить</button>
                <button className="btn" onClick={() => save(patch('blocked'))}>Заблокировать</button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={!role} onClick={() => save(patch('approved'))}>
                {device.status === 'blocked' ? 'Разблокировать' : 'Одобрить'}
              </button>
            )}
            <button className="btn btn-danger" onClick={remove}>Удалить</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Пользователи ----------
function UsersTab({ call, run, notify }: { call: Call; run: Run; notify: Notify }) {
  const { list, page, setPage, load } = usePagedList<UserRow>(call, notify, '/api/users');
  const [form, setForm] = useState({ user_id: '', name: '', accessLevel: 'firstLevel', startWorkDay: '6', endWorkDay: '18' });

  const set = (field: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [field]: e.target.value });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        call('/api/users', 'POST', {
          user_id: form.user_id.trim(),
          name: form.name.trim(),
          accessLevel: form.accessLevel.trim() || 'firstLevel',
          startWorkDay: Number(form.startWorkDay),
          endWorkDay: Number(form.endWorkDay),
        }),
      'Пользователь добавлен',
    );
    if (ok) {
      setForm({ ...form, user_id: '', name: '' });
      void load();
    }
  };

  const after = (p: Promise<boolean>) => void p.then((ok) => { if (ok) void load(); });

  return (
    <>
      <section className="block">
        <h2>Новый пользователь</h2>
        <form className="fields" onSubmit={create}>
          <label className="field"><span>Номер карты</span><input value={form.user_id} onChange={set('user_id')} required maxLength={64} /></label>
          <label className="field"><span>Имя</span><input value={form.name} onChange={set('name')} maxLength={100} /></label>
          <label className="field"><span>Уровень доступа</span><input value={form.accessLevel} onChange={set('accessLevel')} maxLength={50} /></label>
          <label className="field"><span>Смена с (час)</span><input type="number" min={0} max={23} value={form.startWorkDay} onChange={set('startWorkDay')} required /></label>
          <label className="field"><span>Смена до (час)</span><input type="number" min={0} max={23} value={form.endWorkDay} onChange={set('endWorkDay')} required /></label>
          <div><button className="btn btn-primary">Добавить</button></div>
        </form>
      </section>

      <section className="block">
        <h2>Пользователи{list ? `: ${list.total}` : ''}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Имя</th>
                <th scope="col">Карта</th>
                <th scope="col">Уровень</th>
                <th scope="col">Смена</th>
                <th scope="col">Отработано</th>
                <th scope="col"><span className="visually-hidden">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {list?.data.map((u) => (
                <tr key={u._id}>
                  <td>{u.name || 'Без имени'}</td>
                  <td>{u.user_id}</td>
                  <td>{u.accessLevel}</td>
                  <td>{u.startWorkDay}:00 до {u.endWorkDay}:00</td>
                  <td>{formatWork(u.totalWorkMs)}</td>
                  <td className="row-actions">
                    <button className="btn btn-small" onClick={() => after(run(() => call('/api/users/reset-time', 'POST', { user_id: u.user_id }), 'Время сброшено'))}>Сбросить время</button>
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() => window.confirm(`Удалить пользователя ${u.name || u.user_id}?`) && after(run(() => call(`/api/users/${u._id}`, 'DELETE'), 'Пользователь удалён'))}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list && list.data.length === 0 && <p className="empty">Пользователей пока нет. Добавьте вручную или включите режим добавления карт.</p>}
        <Pager page={page} pages={list?.pages ?? 1} onPage={setPage} />
        <div className="actions">
          <button
            className="btn btn-danger"
            onClick={() => window.confirm('Сбросить отработанное время у всех пользователей?') && after(run(() => call('/api/users/reset-time', 'POST', {}), 'Время сброшено у всех'))}
          >
            Сбросить время у всех
          </button>
        </div>
      </section>
    </>
  );
}

// ---------- Журнал ----------
function LogsTab({ call, run, notify }: { call: Call; run: Run; notify: Notify }) {
  const { list, page, setPage, load } = usePagedList<LogRow>(call, notify, '/api/data');

  const after = (p: Promise<boolean>) => void p.then((ok) => { if (ok) void load(); });

  return (
    <section className="block">
      <h2>Журнал проходов{list ? `: ${list.total}` : ''}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Время</th>
              <th scope="col">Карта</th>
              <th scope="col">Направление</th>
              <th scope="col">Результат</th>
              <th scope="col"><span className="visually-hidden">Действия</span></th>
            </tr>
          </thead>
          <tbody>
            {list?.data.map((l) => (
              <tr key={l._id}>
                <td>{formatTime(l.timestamp)}</td>
                <td>{l.user_id}</td>
                <td>{l.isEntry ? 'Вход' : 'Выход'}</td>
                <td className="result" data-ok={l.access}>{REASON_LABEL[l.reason] ?? l.reason}</td>
                <td className="row-actions">
                  <button className="btn btn-small btn-danger" onClick={() => after(run(() => call(`/api/data/${l._id}`, 'DELETE'), 'Запись удалена'))}>Удалить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list && list.data.length === 0 && <p className="empty">Записей пока нет. Они появятся после первого сканирования карты.</p>}
      <Pager page={page} pages={list?.pages ?? 1} onPage={setPage} />
      <div className="actions">
        <button
          className="btn btn-danger"
          onClick={() =>
            window.confirm('Удалить весь журнал? Счётчик людей внутри тоже обнулится.') && after(run(() => call('/api/data-all', 'DELETE'), 'Журнал очищен'))
          }
        >
          Очистить журнал
        </button>
      </div>
    </section>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="btn btn-small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Назад</button>
      <span>Страница {page} из {pages}</span>
      <button className="btn btn-small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Вперёд</button>
    </div>
  );
}