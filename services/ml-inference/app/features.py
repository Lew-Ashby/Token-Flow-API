import numpy as np
from typing import Dict, List, Any

class FeatureExtractor:
    def __init__(self):
        self.dex_programs = {
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  # Raydium
            'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',    # Orca
            'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',    # Jupiter
            'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',    # Jupiter v4
        }

        self.bridge_programs = {
            'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',    # Wormhole
            'DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe',    # Portal
        }

        self.lending_programs = {
            'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',    # Solend
            'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',    # MarginFi
        }

    def extract_features(self, transaction: Dict[str, Any]) -> np.ndarray:
        instructions = transaction.get('instructions', [])
        accounts = transaction.get('accounts', [])
        fee = transaction.get('fee', 0)

        num_instructions = len(instructions)
        num_accounts = len(accounts)
        fee_paid = fee

        transfer_count = sum(
            1 for inst in instructions
            if self._is_transfer_instruction(inst)
        )

        unique_tokens = len(set(
            inst.get('parsed', {}).get('info', {}).get('mint', '')
            for inst in instructions
            if self._is_transfer_instruction(inst)
        ))

        has_dex = int(any(
            acc in self.dex_programs for acc in accounts
        ))

        has_bridge = int(any(
            acc in self.bridge_programs for acc in accounts
        ))

        has_lending = int(any(
            acc in self.lending_programs for acc in accounts
        ))

        amounts = [
            int(inst.get('parsed', {}).get('info', {}).get('amount', 0))
            for inst in instructions
            if self._is_transfer_instruction(inst)
        ]

        amount_dispersion = np.std(amounts) if len(amounts) > 1 else 0

        program_diversity = len(set(
            inst.get('program', inst.get('programId', ''))
            for inst in instructions
        ))

        features = np.array([
            num_instructions,
            num_accounts,
            fee_paid,
            transfer_count,
            unique_tokens,
            has_dex,
            has_bridge,
            has_lending,
            amount_dispersion,
            program_diversity,
        ], dtype=np.float64)

        return features

    def _is_transfer_instruction(self, instruction: Dict[str, Any]) -> bool:
        if instruction.get('program') == 'spl-token':
            parsed_type = instruction.get('parsed', {}).get('type', '')
            return parsed_type in ['transfer', 'transferChecked']
        return False
