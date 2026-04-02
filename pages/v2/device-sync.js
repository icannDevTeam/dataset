/**
 * Device Sync — Pull missed attendance events from Hikvision terminals
 *
 * Features:
 *   1. Connect to any device and browse its stored event logs
 *   2. One-click sync: pull missed face events → Firestore
 *   3. Date range picker for backfilling specific days
 *   4. Shows sync results with detailed per-day breakdown
 */

import Head from 'next/head';
import { useState, useCallback } from 'react';
import axios from 'axios';
import V2Layout from '../../components/v2/V2Layout';

function getWIBToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function getDaysArray(start, end) {
  const dates = [];
  const d = new Date(start);
  const e = new Date(end);
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

export default function DeviceSyncPage() {
  // Connection
  const [device, setDevice] = useState({ ip: '', username: 'admin', password: '' });
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [error, setError] = useState('');

  // Event browser
  const [eventDate, setEventDate] = useState(getWIBToday());
  const [events, setEvents] = useState([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventSupported, setEventSupported] = useState(true);
  const [eventPage, setEventPage] = useState(0);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);

  // Sync
  const [syncFrom, setSyncFrom] = useState(getWIBToday());
  const [syncTo, setSyncTo] = useState(getWIBToday());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // Saved credentials
  const savedCreds = typeof window !== 'undefined'
    ? (() => { try { return JSON.parse(localStorage.getItem('hik_creds') || '{}'); } catch { return {}; } })()
    : {};

  const handleConnect = async () => {
    setError('');
    setConnecting(true);
    try {
      const res = await axios.post('/api/hikvision/connect', device);
      setDeviceInfo(res.data.device);
      setConnected(true);
      // Load events for today
      loadEvents(eventDate, 0);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.details || err.message);
    } finally {
      setConnecting(false);
    }
  };

  const loadEvents = useCallback(async (date, page) => {
    setLoadingEvents(true);
    setError('');
    try {
      const res = await axios.post('/api/hikvision/events', {
        ...device,
        date,
        page,
        pageSize: 50,
      });
      setEventSupported(res.data.supported);
      if (res.data.supported) {
        if (page === 0) {
          setEvents(res.data.events);
        } else {
          setEvents((prev) => [...prev, ...res.data.events]);
        }
        setTotalEvents(res.data.totalEvents);
        setHasMoreEvents(res.data.hasMore);
        setEventPage(page);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoadingEvents(false);
    }
  }, [device]);

  const handleDateChange = (date) => {
    setEventDate(date);
    setEvents([]);
    setEventPage(0);
    if (connected) loadEvents(date, 0);
  };

  const handleSync = async () => {
    setError('');
    setSyncing(true);
    setSyncResult(null);
    try {
      const dates = getDaysArray(syncFrom, syncTo);
      if (dates.length === 0) {
        setError('Invalid date range');
        setSyncing(false);
        return;
      }
      const res = await axios.post('/api/hikvision/sync', {
        ...device,
        dates,
      });
      setSyncResult(res.data);
      // Refresh events view
      if (connected) loadEvents(eventDate, 0);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleQuickSync = async (label, dates) => {
    setError('');
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await axios.post('/api/hikvision/sync', { ...device, dates });
      setSyncResult(res.data);
      if (connected) loadEvents(eventDate, 0);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSyncing(false);
    }
  };

  const faceEvents = events.filter((e) => e.isFaceEvent);
  const today = getWIBToday();

  return (
    <V2Layout>
      <Head><title>Device Sync — BINUSFace v2</title></Head>

      <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              <i className="ph ph-cloud-arrow-down text-brand-400 mr-3"></i>
              Device Sync
            </h1>
            <p className="text-slate-400 mt-2 max-w-2xl">
              Pull missed attendance events from Hikvision terminals and sync to the dashboard.
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <i className="ph ph-warning-circle mr-2"></i>{error}
          </div>
        )}

        {/* Connect Panel */}
        {!connected && (
          <div className="glass-panel rounded-2xl p-6 mb-8 border border-slate-700/50">
            <h2 className="text-lg font-semibold text-white mb-4">
              <i className="ph ph-plug mr-2 text-brand-400"></i>Connect to Device
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">IP Address</label>
                <input
                  type="text"
                  value={device.ip}
                  onChange={(e) => setDevice({ ...device, ip: e.target.value })}
                  placeholder="10.26.30.201"
                  className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 focus:ring-1 focus:ring-brand-400 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Username</label>
                <input
                  type="text"
                  value={device.username}
                  onChange={(e) => setDevice({ ...device, username: e.target.value })}
                  placeholder="admin"
                  className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 focus:ring-1 focus:ring-brand-400 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
                <input
                  type="password"
                  value={device.password}
                  onChange={(e) => setDevice({ ...device, password: e.target.value })}
                  className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 focus:ring-1 focus:ring-brand-400 outline-none"
                />
              </div>
            </div>
            <button
              onClick={handleConnect}
              disabled={connecting || !device.ip || !device.password}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connecting ? (
                <><i className="ph ph-spinner animate-spin"></i> Connecting...</>
              ) : (
                <><i className="ph ph-plug"></i> Connect</>
              )}
            </button>
          </div>
        )}

        {/* Connected — Device Info Bar */}
        {connected && deviceInfo && (
          <div className="glass-panel rounded-2xl p-4 mb-6 border border-slate-700/50 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></div>
              <span className="text-white font-medium">{deviceInfo.model || 'Device'}</span>
            </div>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400 text-sm">{device.ip}</span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400 text-sm">FW {deviceInfo.firmware}</span>
            <span className="text-slate-500">|</span>
            <span className="text-slate-400 text-sm">SN: {deviceInfo.serial?.slice(-8)}</span>
            <div className="ml-auto">
              <button
                onClick={() => { setConnected(false); setDeviceInfo(null); setEvents([]); setSyncResult(null); }}
                className="text-xs text-slate-500 hover:text-red-400 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {connected && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Event Browser */}
            <div className="glass-panel rounded-2xl p-6 border border-slate-700/50">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">
                  <i className="ph ph-list-magnifying-glass mr-2 text-brand-400"></i>Device Event Log
                </h2>
                <input
                  type="date"
                  value={eventDate}
                  max={today}
                  onChange={(e) => handleDateChange(e.target.value)}
                  className="px-3 py-1.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 outline-none"
                />
              </div>

              {!eventSupported && (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm mb-4">
                  <i className="ph ph-warning mr-2"></i>
                  This device does not support event search. Only live stream events can be captured.
                </div>
              )}

              {loadingEvents && events.length === 0 && (
                <div className="flex items-center justify-center py-12 text-slate-500">
                  <i className="ph ph-spinner animate-spin text-2xl mr-3"></i>Loading events...
                </div>
              )}

              {eventSupported && !loadingEvents && events.length === 0 && (
                <div className="text-center py-12 text-slate-500">
                  <i className="ph ph-calendar-blank text-4xl mb-2 block"></i>
                  No events found for {eventDate}
                </div>
              )}

              {events.length > 0 && (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-slate-500">
                      {totalEvents} total events · {faceEvents.length} face verifications shown
                    </span>
                    <div className="flex gap-2">
                      <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400">
                        ✓ {faceEvents.filter((e) => e.name).length} identified
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-[500px] overflow-y-auto no-scrollbar">
                    {events.map((evt, i) => (
                      <div
                        key={i}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${
                          evt.isFaceEvent
                            ? 'bg-slate-800/60 border border-slate-700/30'
                            : 'text-slate-600'
                        }`}
                      >
                        <span className="text-slate-500 text-xs font-mono w-14 flex-shrink-0">
                          {evt.time?.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] || ''}
                        </span>
                        {evt.isFaceEvent ? (
                          <>
                            <i className="ph ph-user-check text-emerald-400"></i>
                            <span className="text-white font-medium truncate">
                              {evt.name || <span className="text-slate-500 italic">Unknown</span>}
                            </span>
                            {evt.employeeNo && (
                              <span className="text-slate-500 text-xs ml-auto flex-shrink-0">
                                #{evt.employeeNo}
                              </span>
                            )}
                            {evt.mask === 'yes' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400">mask</span>
                            )}
                          </>
                        ) : (
                          <>
                            <i className="ph ph-door text-slate-600"></i>
                            <span className="text-slate-600 truncate">{evt.type}</span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {hasMoreEvents && (
                    <button
                      onClick={() => loadEvents(eventDate, eventPage + 1)}
                      disabled={loadingEvents}
                      className="mt-3 w-full py-2 text-sm text-slate-400 hover:text-white bg-slate-800/40 hover:bg-slate-800/80 rounded-lg transition-colors"
                    >
                      {loadingEvents ? 'Loading...' : 'Load More'}
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Right: Sync Panel */}
            <div className="space-y-6">
              {/* Quick Sync */}
              <div className="glass-panel rounded-2xl p-6 border border-slate-700/50">
                <h2 className="text-lg font-semibold text-white mb-4">
                  <i className="ph ph-lightning mr-2 text-amber-400"></i>Quick Sync
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleQuickSync('Today', [today])}
                    disabled={syncing}
                    className="px-4 py-3 bg-brand-500/10 hover:bg-brand-500/20 border border-brand-500/30 rounded-xl text-brand-400 text-sm font-medium transition-all disabled:opacity-40"
                  >
                    <i className="ph ph-calendar-check block text-2xl mb-1"></i>
                    Today
                  </button>
                  <button
                    onClick={() => {
                      const yday = new Date(Date.now() + 7 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
                      handleQuickSync('Yesterday', [yday]);
                    }}
                    disabled={syncing}
                    className="px-4 py-3 bg-slate-800/60 hover:bg-slate-800/80 border border-slate-700/50 rounded-xl text-slate-300 text-sm font-medium transition-all disabled:opacity-40"
                  >
                    <i className="ph ph-clock-counter-clockwise block text-2xl mb-1"></i>
                    Yesterday
                  </button>
                  <button
                    onClick={() => {
                      const dates = [];
                      for (let i = 0; i < 7; i++) {
                        dates.push(new Date(Date.now() + 7 * 3600 * 1000 - i * 86400 * 1000).toISOString().slice(0, 10));
                      }
                      handleQuickSync('Last 7 days', dates);
                    }}
                    disabled={syncing}
                    className="px-4 py-3 bg-slate-800/60 hover:bg-slate-800/80 border border-slate-700/50 rounded-xl text-slate-300 text-sm font-medium transition-all disabled:opacity-40"
                  >
                    <i className="ph ph-calendar-dots block text-2xl mb-1"></i>
                    Last 7 Days
                  </button>
                  <button
                    onClick={() => {
                      const dates = [];
                      for (let i = 0; i < 30; i++) {
                        dates.push(new Date(Date.now() + 7 * 3600 * 1000 - i * 86400 * 1000).toISOString().slice(0, 10));
                      }
                      handleQuickSync('Last 30 days', dates);
                    }}
                    disabled={syncing}
                    className="px-4 py-3 bg-slate-800/60 hover:bg-slate-800/80 border border-slate-700/50 rounded-xl text-slate-300 text-sm font-medium transition-all disabled:opacity-40"
                  >
                    <i className="ph ph-calendar block text-2xl mb-1"></i>
                    Last 30 Days
                  </button>
                </div>

                {syncing && (
                  <div className="mt-4 flex items-center gap-3 text-brand-400 text-sm">
                    <i className="ph ph-spinner animate-spin text-lg"></i>
                    Syncing events from device...
                  </div>
                )}
              </div>

              {/* Custom Date Range */}
              <div className="glass-panel rounded-2xl p-6 border border-slate-700/50">
                <h2 className="text-lg font-semibold text-white mb-4">
                  <i className="ph ph-calendar-plus mr-2 text-indigo-400"></i>Custom Date Range
                </h2>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">From</label>
                    <input
                      type="date"
                      value={syncFrom}
                      max={today}
                      onChange={(e) => setSyncFrom(e.target.value)}
                      className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">To</label>
                    <input
                      type="date"
                      value={syncTo}
                      max={today}
                      onChange={(e) => setSyncTo(e.target.value)}
                      className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white text-sm focus:border-brand-400 outline-none"
                    />
                  </div>
                </div>
                <button
                  onClick={handleSync}
                  disabled={syncing || !syncFrom || !syncTo}
                  className="w-full flex items-center justify-center gap-2 px-6 py-2.5 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {syncing ? (
                    <><i className="ph ph-spinner animate-spin"></i> Syncing...</>
                  ) : (
                    <><i className="ph ph-cloud-arrow-down"></i> Sync Date Range</>
                  )}
                </button>
              </div>

              {/* Sync Results */}
              {syncResult && (
                <div className="glass-panel rounded-2xl p-6 border border-slate-700/50">
                  <h2 className="text-lg font-semibold text-white mb-4">
                    <i className="ph ph-check-circle mr-2 text-emerald-400"></i>Sync Results
                  </h2>

                  {!syncResult.supported && (
                    <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
                      <i className="ph ph-warning mr-2"></i>
                      {syncResult.message}
                    </div>
                  )}

                  {syncResult.supported && (
                    <>
                      <div className="grid grid-cols-3 gap-3 mb-4">
                        <div className="text-center p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                          <div className="text-2xl font-bold text-emerald-400">{syncResult.synced}</div>
                          <div className="text-xs text-emerald-400/70">Synced</div>
                        </div>
                        <div className="text-center p-3 rounded-xl bg-slate-800/60 border border-slate-700/30">
                          <div className="text-2xl font-bold text-slate-300">{syncResult.skipped}</div>
                          <div className="text-xs text-slate-500">Already Recorded</div>
                        </div>
                        <div className="text-center p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                          <div className="text-2xl font-bold text-red-400">{syncResult.errors}</div>
                          <div className="text-xs text-red-400/70">Errors</div>
                        </div>
                      </div>

                      {syncResult.details?.length > 0 && (
                        <div className="space-y-2">
                          {syncResult.details.map((d, i) => (
                            <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800/40 text-sm">
                              <span className="text-slate-300 font-mono">{d.date}</span>
                              {d.error ? (
                                <span className="text-red-400 text-xs">{d.error}</span>
                              ) : (
                                <div className="flex gap-3 text-xs">
                                  <span className="text-slate-500">{d.deviceEvents} on device</span>
                                  <span className="text-emerald-400">+{d.synced} new</span>
                                  <span className="text-slate-600">{d.skipped} skipped</span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </V2Layout>
  );
}
