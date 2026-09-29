import { Column, Entity, PrimaryColumn, type DataSource, type EntityManager } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  afterCommit,
  bindTransactionManager,
  getTransactionManager,
  isInTransaction,
  joinCommits,
  resolveManager,
  runInTransaction,
  transactionDepth,
} from './transaction';
import { createTestDataSource } from './testing';

@Entity({ name: 'tx_test_row' })
class TxTestRow {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  value!: string;
}

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = await createTestDataSource([TxTestRow]);
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(TxTestRow).clear();
});

const countRows = async (): Promise<number> => dataSource.getRepository(TxTestRow).count();
const insert = (manager: EntityManager, id: string) => manager.save(TxTestRow, { id, value: id });

describe('ambient transaction', () => {
  it('is absent outside a transaction', () => {
    expect(isInTransaction()).toBe(false);
    expect(getTransactionManager()).toBeUndefined();
    expect(transactionDepth()).toBe(0);
  });

  it('is present inside, and resolveManager returns the transactional one', async () => {
    await runInTransaction(dataSource, async (manager) => {
      expect(isInTransaction()).toBe(true);
      expect(transactionDepth()).toBe(1);
      // This is the whole point: a mortar package calling resolveManager()
      // deep inside application code gets the caller's transaction.
      expect(resolveManager(dataSource)).toBe(manager);
    });
    expect(isInTransaction()).toBe(false);
  });

  it('falls back to the pool manager outside a transaction', () => {
    expect(resolveManager(dataSource)).toBe(dataSource.manager);
  });
});

describe('commit and rollback', () => {
  it('commits work on success', async () => {
    await runInTransaction(dataSource, async (manager) => insert(manager, 'a'));
    expect(await countRows()).toBe(1);
  });

  it('rolls back everything on failure', async () => {
    await expect(
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'a');
        await insert(manager, 'b');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countRows()).toBe(0);
  });

  it('returns the value the work produced', async () => {
    const result = await runInTransaction(dataSource, async () => 'value');
    expect(result).toBe('value');
  });
});

describe('nesting via savepoints', () => {
  it('joins the outer transaction rather than opening a second', async () => {
    await runInTransaction(dataSource, async (outer) => {
      await runInTransaction(dataSource, async (inner) => {
        // Same manager: the inner call is a savepoint, not a new connection.
        expect(inner).toBe(outer);
        expect(transactionDepth()).toBe(2);
      });
    });
  });

  it('rolls back only the inner work when the inner fails and is caught', async () => {
    await runInTransaction(dataSource, async (manager) => {
      await insert(manager, 'outer');
      await expect(
        runInTransaction(dataSource, async (inner) => {
          await insert(inner, 'inner');
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
      // The outer transaction is still usable — this is exactly what a
      // savepoint buys, and what a second connection could not provide.
      await insert(manager, 'after');
    });

    const ids = (await dataSource.getRepository(TxTestRow).find()).map((r) => r.id).sort();
    expect(ids).toEqual(['after', 'outer']);
  });

  it('rolls back everything when an inner failure propagates', async () => {
    await expect(
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'outer');
        await runInTransaction(dataSource, async (inner) => {
          await insert(inner, 'inner');
          throw new Error('propagates');
        });
      }),
    ).rejects.toThrow('propagates');
    expect(await countRows()).toBe(0);
  });

  it('supports several levels', async () => {
    await runInTransaction(dataSource, async (m1) => {
      await insert(m1, 'l1');
      await runInTransaction(dataSource, async (m2) => {
        await insert(m2, 'l2');
        await runInTransaction(dataSource, async (m3) => {
          await insert(m3, 'l3');
          expect(transactionDepth()).toBe(3);
        });
      });
    });
    expect(await countRows()).toBe(3);
  });
});

describe('independent transactions', () => {
  it('survives the outer transaction rolling back', async () => {
    await expect(
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'doomed');
        await runInTransaction(dataSource, async (independent) => insert(independent, 'survivor'), {
          independent: true,
        });
        throw new Error('outer failed');
      }),
    ).rejects.toThrow('outer failed');

    const ids = (await dataSource.getRepository(TxTestRow).find()).map((r) => r.id);
    expect(ids).toEqual(['survivor']);
  });
});

describe('afterCommit', () => {
  it('runs callbacks only after the transaction commits', async () => {
    const order: string[] = [];
    await runInTransaction(dataSource, async (manager) => {
      await afterCommit(() => {
        order.push('callback');
      });
      await insert(manager, 'a');
      order.push('work');
    });
    expect(order).toEqual(['work', 'callback']);
  });

  it('does not run callbacks when the transaction rolls back', async () => {
    const fired: string[] = [];
    await expect(
      runInTransaction(dataSource, async () => {
        await afterCommit(() => {
          fired.push('should not fire');
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(fired).toEqual([]);
  });

  it('fires nested callbacks once, after the outermost commit', async () => {
    const fired: string[] = [];
    await runInTransaction(dataSource, async () => {
      await afterCommit(() => void fired.push('outer'));
      await runInTransaction(dataSource, async () => {
        await afterCommit(() => void fired.push('inner'));
      });
      expect(fired).toEqual([]);
    });
    expect(fired).toEqual(['outer', 'inner']);
  });

  it('drops what was registered in a savepoint that rolled back, and keeps the rest', async () => {
    const fired: string[] = [];
    await runInTransaction(dataSource, async () => {
      await afterCommit(() => void fired.push('outer'));
      await expect(
        runInTransaction(dataSource, async () => {
          await afterCommit(() => void fired.push('rolled back'));
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
    });

    /*
     * The transaction committed, but not the savepoint's work — so not what was
     * to follow it. Sharing one list with the outermost level ran it anyway:
     * the email for an account whose creation was undone, sent regardless.
     */
    expect(fired).toEqual(['outer']);
  });

  it('drops every level inside a savepoint that rolled back', async () => {
    const fired: string[] = [];
    await runInTransaction(dataSource, async () => {
      await expect(
        runInTransaction(dataSource, async () => {
          await afterCommit(() => void fired.push('middle'));
          // Released into the middle level, which then rolls back.
          await runInTransaction(dataSource, async () => {
            await afterCommit(() => void fired.push('inner'));
          });
          throw new Error('middle failed');
        }),
      ).rejects.toThrow('middle failed');
    });

    expect(fired).toEqual([]);
  });

  it('runs what every level registered in the order it was registered', async () => {
    const fired: string[] = [];
    await runInTransaction(dataSource, async () => {
      await afterCommit(() => void fired.push('first'));
      await runInTransaction(dataSource, async () => {
        await afterCommit(() => void fired.push('second'));
      });
      await afterCommit(() => void fired.push('third'));
    });

    expect(fired).toEqual(['first', 'second', 'third']);
  });

  it('runs immediately when there is no transaction, so callers need not branch', async () => {
    const fired: string[] = [];
    await afterCommit(() => void fired.push('immediate'));
    expect(fired).toEqual(['immediate']);
  });
});

describe('bindTransactionManager', () => {
  it('lets mortar writes join a transaction opened by application code', async () => {
    await dataSource.transaction(async (manager) => {
      await bindTransactionManager(manager, async () => {
        expect(isInTransaction()).toBe(true);
        expect(resolveManager(dataSource)).toBe(manager);
        await insert(resolveManager(dataSource), 'bound');
      });
    });
    expect(await countRows()).toBe(1);
  });

  it('refuses afterCommit, whose callback it could never run', async () => {
    const fired: string[] = [];
    await dataSource.transaction(async (manager) => {
      await bindTransactionManager(manager, async () => {
        // The application commits this transaction, out of mortar's sight.
        await expect(afterCommit(() => void fired.push('never'))).rejects.toThrow(
          /bindTransactionManager/,
        );
        // Nor inside a savepoint within it.
        await runInTransaction(dataSource, async () => {
          await expect(afterCommit(() => void fired.push('never'))).rejects.toThrow(
            /bindTransactionManager/,
          );
        });
      });
    });

    expect(fired).toEqual([]);
  });

  it('rejects a non-transactional manager', async () => {
    await expect(bindTransactionManager(dataSource.manager, async () => undefined)).rejects.toThrow(
      /requires a transactional EntityManager/,
    );
  });
});

describe('joinCommits', () => {
  /** A participant that writes `marker` in each transaction it joins, and notes when that commits. */
  const participant = (marker: string, seen: string[]) => async (manager: EntityManager) => {
    await insert(manager, `${marker}-${seen.length}`);
    seen.push('joined');
    return () => void seen.push('committed');
  };
  const markers = async (marker: string) =>
    (await dataSource.getRepository(TxTestRow).find())
      .map((row) => row.id)
      .filter((id) => id.startsWith(marker));

  it('writes inside the transaction, just before it commits: with the work, or not at all', async () => {
    const seen: string[] = [];
    await joinCommits(participant('mark', seen), () =>
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'work');
        // Not yet: it joins as the transaction's last work.
        expect(seen).toEqual([]);
      }),
    );

    expect(seen).toEqual(['joined', 'committed']);
    expect(await markers('mark')).toEqual(['mark-0']);
    expect(await countRows()).toBe(2);
  });

  it('is never called for work that fails, which rolls back without it', async () => {
    const seen: string[] = [];
    await expect(
      joinCommits(participant('mark', seen), () =>
        runInTransaction(dataSource, async (manager) => {
          await insert(manager, 'work');
          throw new Error('refused');
        }),
      ),
    ).rejects.toThrow('refused');

    expect(seen).toEqual([]);
    expect(await countRows()).toBe(0);
  });

  it('takes the work down with it when it throws', async () => {
    await expect(
      joinCommits(
        async () => {
          throw new Error('participant failed');
        },
        () => runInTransaction(dataSource, (manager) => insert(manager, 'work')),
      ),
    ).rejects.toThrow('participant failed');

    expect(await countRows()).toBe(0);
  });

  it('joins the transaction that commits, never a savepoint inside it', async () => {
    const seen: string[] = [];
    await joinCommits(participant('mark', seen), () =>
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'outer');
        await runInTransaction(dataSource, (inner) => insert(inner, 'inner'));
      }),
    );

    expect(seen).toEqual(['joined', 'committed']);
  });

  it('joins every transaction committed inside it, in any continuation, and none outside', async () => {
    const seen: string[] = [];
    await joinCommits(participant('mark', seen), async () => {
      await runInTransaction(dataSource, (manager) => insert(manager, 'first'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runInTransaction(dataSource, (manager) => insert(manager, 'second'), {
        independent: true,
      });
    });
    await runInTransaction(dataSource, (manager) => insert(manager, 'after'));

    expect(seen).toEqual(['joined', 'committed', 'joined', 'committed']);
    expect(await markers('mark')).toHaveLength(2);
  });

  it('runs its callback only once the commit is visible from outside', async () => {
    let visible: number | undefined;
    await joinCommits(
      async () => async () => {
        visible = await dataSource.getRepository(TxTestRow).countBy({ id: 'work' });
      },
      () => runInTransaction(dataSource, (manager) => insert(manager, 'work')),
    );
    // The callback is not awaited by the commit; give it its turn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(visible).toBe(1);
  });

  it('is not joined to a transaction the application commits', async () => {
    const seen: string[] = [];
    await joinCommits(participant('mark', seen), () =>
      dataSource.transaction((manager) =>
        bindTransactionManager(manager, () => insert(manager, 'bound')),
      ),
    );

    expect(seen).toEqual([]);
  });
});

describe('isolation between concurrent transactions', () => {
  it('keeps parallel transactions from seeing each other', async () => {
    const seen: number[] = [];
    await Promise.all([
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'p1');
        seen.push(transactionDepth());
      }),
      runInTransaction(dataSource, async (manager) => {
        await insert(manager, 'p2');
        seen.push(transactionDepth());
      }),
    ]);
    expect(seen).toEqual([1, 1]);
    expect(await countRows()).toBe(2);
  });
});
