/**
 * Device Manager — View and manage all enrolled students on the Hikvision device.
 *
 * Features:
 *   - Connect to device with credentials
 *   - View all enrolled users in a sortable, filterable table
 *   - Group/filter by grade level, homeroom
 *   - Delete individual students or bulk delete
 *   - Device capacity indicator
 */

import Head from 'next/head';
import Link from 'next/link';
import React, { useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import styles from '../styles/device-manager.module.css';

export default function DeviceManager() {
  // Connection
  const [device, setDevice] = useState({
    ip: '10.26.30.200',
    username: '',
    password: '',
  });
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [capacity, setCapacity] = useState({});

  // Users
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');

  // Filters & sorting
  const [search, setSearch] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterHomeroom, setFilterHomeroom] = useState('');
  const [filterFace, setFilterFace] = useState(''); // 'has' | 'missing' | ''
  const [sortField, setSortField] = useState('name');
  const [sortDir, setSortDir] = useState('asc');

  // Selection for bulk actions
  const [selected, setSelected] = useState(new Set());

  // Delete state
  const [deleting, setDeleting] = useState(new Set());
  const [deleteLog, setDeleteLog] = useState([]);

  // ── Connect to device ──
  const handleConnect = async () => {
    setError('');
    setConnecting(true);
    try {
      const res = await axios.post('/api/hikvision/users', { device });
      setUsers(res.data.users || []);
      setDeviceInfo(res.data.device);
      setCapacity(res.data.capacity || {});
      setConnected(true);
      setSelected(new Set());
      setDeleteLog([]);
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.details || err.message;
      setError(`Connection failed: ${msg}`);
    } finally {
      setConnecting(false);
    }
  };

  // ── Refresh user list ──
  const refresh = async () => {
    try {
      const res = await axios.post('/api/hikvision/users', { device });
      setUsers(res.data.users || []);
      setCapacity(res.data.capacity || {});
      setSelected(new Set());
    } catch (e) { /* ignore */ }
  };

  // ── Delete single user ──
  const handleDelete = async (user) => {
    if (!confirm(`Remove "${user.name}" (${user.employeeNo}) from the device?\n\nThis will delete the user and their face data.`)) return;

    setDeleting((prev) => new Set([...prev, user.employeeNo]));
    try {
      await axios.post('/api/hikvision/delete', {
        device,
        employeeNo: user.employeeNo,
        name: user.name,
      });
      setUsers((prev) => prev.filter((u) => u.employeeNo !== user.employeeNo));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(user.employeeNo);
        return next;
      });
      setDeleteLog((prev) => [...prev, { name: user.name, success: true }]);
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      setError(`Failed to delete ${user.name}: ${msg}`);
      setDeleteLog((prev) => [...prev, { name: user.name, success: false, error: msg }]);
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(user.employeeNo);
        return next;
      });
    }
  };

  // ── Bulk delete ──
  const handleBulkDelete = async () => {
    const toDelete = users.filter((u) => selected.has(u.employeeNo));
    if (toDelete.length === 0) return;
    if (!confirm(`Remove ${toDelete.length} student(s) from the device?\n\nThis cannot be undone.`)) return;

    setDeleteLog([]);
    for (const user of toDelete) {
      setDeleting((prev) => new Set([...prev, user.employeeNo]));
      try {
        await axios.post('/api/hikvision/delete', {
          device,
          employeeNo: user.employeeNo,
          name: user.name,
        });
        setUsers((prev) => prev.filter((u) => u.employeeNo !== user.employeeNo));
        setDeleteLog((prev) => [...prev, { name: user.name, success: true }]);
      } catch (err) {
        const msg = err.response?.data?.error || err.message;
        setDeleteLog((prev) => [...prev, { name: user.name, success: false, error: msg }]);
      } finally {
        setDeleting((prev) => {
          const next = new Set(prev);
          next.delete(user.employeeNo);
          return next;
        });
      }
    }
    setSelected(new Set());
  };

  // ── Sorting ──
  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortIcon = (field) => {
    if (sortField !== field) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  // ── Derived data ──
  const grades = useMemo(() => {
    const set = new Set(users.map((u) => u.grade).filter(Boolean));
    return [...set].sort();
  }, [users]);

  const homerooms = useMemo(() => {
    const set = new Set(users.map((u) => u.homeroom).filter(Boolean));
    return [...set].sort();
  }, [users]);

  const filteredUsers = useMemo(() => {
    let list = [...users];

    // Search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.employeeNo.toLowerCase().includes(q) ||
          (u.idBinusian && u.idBinusian.toLowerCase().includes(q)) ||
          (u.homeroom && u.homeroom.toLowerCase().includes(q))
      );
    }

    // Grade filter
    if (filterGrade) {
      list = list.filter((u) => u.grade === filterGrade);
    }

    // Homeroom filter
    if (filterHomeroom) {
      list = list.filter((u) => u.homeroom === filterHomeroom);
    }

    // Face filter
    if (filterFace === 'has') {
      list = list.filter((u) => u.numOfFace > 0);
    } else if (filterFace === 'missing') {
      list = list.filter((u) => u.numOfFace === 0);
    }

    // Sort
    list.sort((a, b) => {
      let va = a[sortField] || '';
      let vb = b[sortField] || '';
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortDir === 'asc' ? va - vb : vb - va;
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    return list;
  }, [users, search, filterGrade, filterHomeroom, filterFace, sortField, sortDir]);

  // ── Selection helpers ──
  const toggleSelect = (empNo) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(empNo)) next.delete(empNo);
      else next.add(empNo);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filteredUsers.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredUsers.map((u) => u.employeeNo)));
    }
  };

  const usedPercent = capacity.maxUsers > 0 ? Math.round((users.length / capacity.maxUsers) * 100) : 0;

  // ── Render ──
  return (
    <>
      <Head>
        <title>Device Manager — Hikvision</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <h1>📋 Device Manager</h1>
          <div className={styles.headerActions}>
            <Link href="/dashboard" className={styles.navLink}>📊 Dashboard</Link>
            <Link href="/hikvision" className={styles.navLink}>🔐 Enrollment</Link>
            <Link href="/" className={styles.navLink}>📸 Capture</Link>
          </div>
        </div>

        {error && <div className={styles.error}>{error}<button className={styles.errorClose} onClick={() => setError('')}>✕</button></div>}

        {/* ── Connection Panel ── */}
        {!connected && (
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>📡 Connect to Hikvision Device</h2>
            <div className={styles.formGrid}>
              <div className={styles.formGroup}>
                <label>IP Address</label>
                <input type="text" value={device.ip} onChange={(e) => setDevice({ ...device, ip: e.target.value })} placeholder="10.26.30.200" />
              </div>
              <div className={styles.formGroup}>
                <label>Username</label>
                <input type="text" value={device.username} onChange={(e) => setDevice({ ...device, username: e.target.value })} placeholder="admin" />
              </div>
              <div className={styles.formGroup}>
                <label>Password</label>
                <input type="password" value={device.password} onChange={(e) => setDevice({ ...device, password: e.target.value })} placeholder="password" />
              </div>
            </div>
            <button className={styles.connectBtn} onClick={handleConnect} disabled={connecting || !device.ip}>
              {connecting ? <><span className={styles.spinner}></span> Connecting...</> : 'Connect'}
            </button>
          </div>
        )}

        {/* ── Connected View ── */}
        {connected && (
          <>
            {/* Device bar */}
            <div className={styles.deviceBar}>
              <div className={styles.deviceBarLeft}>
                <span className={styles.deviceDot}></span>
                <span className={styles.deviceModel}>{deviceInfo?.model || device.ip}</span>
                <span className={styles.deviceSerial}>{deviceInfo?.serial?.slice(-10) || ''}</span>
              </div>
              <div className={styles.deviceBarCenter}>
                <div className={styles.capacityWrap}>
                  <div className={styles.capacityBar}>
                    <div className={styles.capacityFill} style={{ width: `${Math.min(usedPercent, 100)}%` }}></div>
                  </div>
                  <span className={styles.capacityLabel}>
                    {users.length} / {capacity.maxUsers || '?'} users
                  </span>
                </div>
              </div>
              <div className={styles.deviceBarRight}>
                <button className={styles.refreshBtn} onClick={refresh} title="Refresh user list">↻</button>
                <button className={styles.disconnectBtn} onClick={() => { setConnected(false); setUsers([]); setSelected(new Set()); }}>Disconnect</button>
              </div>
            </div>

            {/* Toolbar */}
            <div className={styles.toolbar}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder="Search name, ID, homeroom..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select className={styles.filterSelect} value={filterGrade} onChange={(e) => setFilterGrade(e.target.value)}>
                <option value="">All Grades</option>
                {grades.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select className={styles.filterSelect} value={filterHomeroom} onChange={(e) => setFilterHomeroom(e.target.value)}>
                <option value="">All Homerooms</option>
                {homerooms.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <select className={styles.filterSelect} value={filterFace} onChange={(e) => setFilterFace(e.target.value)}>
                <option value="">All Faces</option>
                <option value="has">Has Face</option>
                <option value="missing">No Face</option>
              </select>
              <div className={styles.toolbarSpacer}></div>
              <span className={styles.countBadge}>{filteredUsers.length} of {users.length}</span>
            </div>

            {/* Bulk actions */}
            {selected.size > 0 && (
              <div className={styles.bulkBar}>
                <span>{selected.size} selected</span>
                <button className={styles.bulkDeleteBtn} onClick={handleBulkDelete} disabled={deleting.size > 0}>
                  {deleting.size > 0 ? `Deleting (${deleting.size})...` : `🗑️ Delete ${selected.size} Student${selected.size !== 1 ? 's' : ''}`}
                </button>
                <button className={styles.bulkCancelBtn} onClick={() => setSelected(new Set())}>Cancel</button>
              </div>
            )}

            {/* Delete log */}
            {deleteLog.length > 0 && (
              <div className={styles.deleteLog}>
                {deleteLog.map((entry, i) => (
                  <span key={i} className={entry.success ? styles.logSuccess : styles.logFail}>
                    {entry.success ? '✓' : '✗'} {entry.name}
                  </span>
                ))}
                <button className={styles.logClear} onClick={() => setDeleteLog([])}>Clear</button>
              </div>
            )}

            {/* Table */}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.checkCol}>
                      <input
                        type="checkbox"
                        checked={selected.size > 0 && selected.size === filteredUsers.length}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('name')}>
                      Name <span className={styles.sortIcon}>{sortIcon('name')}</span>
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('employeeNo')}>
                      Employee No <span className={styles.sortIcon}>{sortIcon('employeeNo')}</span>
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('grade')}>
                      Grade <span className={styles.sortIcon}>{sortIcon('grade')}</span>
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('homeroom')}>
                      Homeroom <span className={styles.sortIcon}>{sortIcon('homeroom')}</span>
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('idBinusian')}>
                      Binusian ID <span className={styles.sortIcon}>{sortIcon('idBinusian')}</span>
                    </th>
                    <th className={styles.sortable} onClick={() => handleSort('numOfFace')}>
                      Face <span className={styles.sortIcon}>{sortIcon('numOfFace')}</span>
                    </th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className={styles.emptyRow}>
                        {users.length === 0 ? 'No users enrolled on device' : 'No matching users'}
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => (
                      <tr
                        key={u.employeeNo}
                        className={`${selected.has(u.employeeNo) ? styles.rowSelected : ''} ${deleting.has(u.employeeNo) ? styles.rowDeleting : ''}`}
                      >
                        <td className={styles.checkCol}>
                          <input
                            type="checkbox"
                            checked={selected.has(u.employeeNo)}
                            onChange={() => toggleSelect(u.employeeNo)}
                          />
                        </td>
                        <td className={styles.nameCell}>{u.name}</td>
                        <td className={styles.monoCell}>{u.employeeNo}</td>
                        <td>{u.grade || <span className={styles.dim}>—</span>}</td>
                        <td>{u.homeroom || <span className={styles.dim}>—</span>}</td>
                        <td className={styles.monoCell}>
                          {u.idBinusian || <span className={styles.dim}>—</span>}
                        </td>
                        <td>
                          {u.numOfFace > 0 ? (
                            <span className={styles.faceBadgeOk}>✓ {u.numOfFace}</span>
                          ) : (
                            <span className={styles.faceBadgeMissing}>✗ None</span>
                          )}
                        </td>
                        <td>
                          <button
                            className={styles.deleteBtn}
                            onClick={() => handleDelete(u)}
                            disabled={deleting.has(u.employeeNo)}
                            title={`Remove ${u.name}`}
                          >
                            {deleting.has(u.employeeNo) ? '...' : '🗑️'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
