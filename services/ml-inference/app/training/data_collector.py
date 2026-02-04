import psycopg2
import numpy as np
import os
from typing import Tuple, List
import json

class TrainingDataCollector:
    def __init__(self):
        self.conn = psycopg2.connect(
            host=os.getenv('POSTGRES_HOST', 'localhost'),
            port=int(os.getenv('POSTGRES_PORT', '5432')),
            database=os.getenv('POSTGRES_DB', 'token_flow_db'),
            user=os.getenv('POSTGRES_USER', 'token_flow_user'),
            password=os.getenv('POSTGRES_PASSWORD', '')
        )

    def collect_labeled_transactions(self) -> Tuple[np.ndarray, np.ndarray]:
        cursor = self.conn.cursor()

        cursor.execute("""
            SELECT instructions, accounts, fee
            FROM transactions
            WHERE success = true
            LIMIT 1000
        """)

        rows = cursor.fetchall()

        X_data = []
        y_labels = []

        for row in rows:
            instructions = row[0] if isinstance(row[0], list) else json.loads(row[0])
            accounts = row[1] if isinstance(row[1], list) else json.loads(row[1])
            fee = row[2]

            transaction = {
                'instructions': instructions,
                'accounts': accounts,
                'fee': fee
            }

            label = self._auto_label_transaction(transaction)

            from app.features import FeatureExtractor
            extractor = FeatureExtractor()
            features = extractor.extract_features(transaction)

            X_data.append(features)
            y_labels.append(label)

        cursor.close()

        return np.array(X_data), np.array(y_labels)

    def _auto_label_transaction(self, transaction: dict) -> str:
        accounts = transaction.get('accounts', [])
        instructions = transaction.get('instructions', [])

        dex_programs = {
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        }

        bridge_programs = {
            'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
            'DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe',
        }

        lending_programs = {
            'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',
            'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
        }

        if any(acc in bridge_programs for acc in accounts):
            return 'bridging'

        if any(acc in dex_programs for acc in accounts):
            transfer_count = sum(
                1 for inst in instructions
                if inst.get('program') == 'spl-token' and
                inst.get('parsed', {}).get('type') in ['transfer', 'transferChecked']
            )

            if transfer_count > 2:
                return 'arbitrage'
            else:
                return 'trading'

        if any(acc in lending_programs for acc in accounts):
            return 'yield_farming'

        transfer_count = sum(
            1 for inst in instructions
            if inst.get('program') == 'spl-token' and
            inst.get('parsed', {}).get('type') in ['transfer', 'transferChecked']
        )

        if transfer_count == 1 and len(instructions) == 1:
            return 'transfer'

        return 'unknown'

    def close(self):
        self.conn.close()
