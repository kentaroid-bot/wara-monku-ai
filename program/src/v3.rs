// Devnet v0.3. Community accounts are immutable issuers. Legacy configs never qualify.
use super::*;
const GROUP: u8 = 31;
const SHOP: u8 = 32;
const MEMBER: u8 = 33;
const ALLY: u8 = 34;
const WALLET: u8 = 35;
const LIMIT: u64 = 10;
pub(super) const CREATE_GROUP: u8 = 10;
const CERTIFY_SHOP: u8 = 11;
const JOIN_GROUP: u8 = 12;
const OFFER_ALLIANCE: u8 = 13;
const SPEND_INA: u8 = 14;
pub(super) const TRANSFER_WARA: u8 = 15;
pub(super) const CREATE_METADATA: u8 = 16;
pub(super) const UPDATE_GROUP: u8 = 17;
pub(super) const END_MEMBERSHIP: u8 = 18;
const LEFT: u8 = 3;
const BANNED: u8 = 4;

// Account byte layouts (tag/key fields precede variable-length display text).
const GROUP_HEADER_LEN: usize = 66; // tag + owner + mode + invitation key
const SHOP_HEADER_LEN: usize = 65; // tag + group + merchant
const EDGE_LEN: usize = 66; // tag + from + to + status
const WALLET_LEN: usize = 25; // tag + JST day + spent + nonce
const POLICY_HEADER_LEN: usize = 33; // mode + invitation key
const MAX_METADATA_LEN: usize = 400;
const MAX_SHOP_NAME_LEN: usize = 120;
const SHOP_WARA_PER_INA: u64 = 100;
const AUTHORITY: u8 = 36;
const SET_AUTHORITY: u8 = 19;
const SPONSOR_JOIN: u8 = 20;
const CLOSE_SENDER_ACCOUNT: u8 = 21;

fn pda(program: &Pubkey, seeds: &[&[u8]], account: &AccountInfo) -> Result<u8, ProgramError> {
    let (id, bump) = Pubkey::find_program_address(seeds, program);
    require(id == *account.key, 5)?;
    Ok(bump)
}
pub(super) fn group<'a>(
    g: &AccountInfo<'a>,
    program: &Pubkey,
) -> Result<(Pubkey, u8, Pubkey), ProgramError> {
    require(g.owner == program, 5)?;
    let d = g.try_borrow_data()?;
    require(d.len() > GROUP_HEADER_LEN && d[0] == GROUP, 5)?;
    Ok((
        Pubkey::new_from_array(d[1..33].try_into().unwrap()),
        d[33],
        Pubkey::new_from_array(d[34..66].try_into().unwrap()),
    ))
}
fn ensure_pda<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    seeds: &[&[u8]],
    len: usize,
) -> ProgramResult {
    require(*sys.key == system_program::id(), 5)?;
    let bump = [pda(program, seeds, account)?];
    if account.owner != program {
        let mut full = seeds.to_vec();
        full.push(&bump);
        create_pda(payer, account, sys, program, len, &full)?;
    }
    require(account.owner == program && account.data_len() == len, 5)
}
fn edge_set<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    row: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    prefix: &[u8],
    tag: u8,
    from: &Pubkey,
    to: &Pubkey,
    status: u8,
) -> ProgramResult {
    ensure_pda(
        program,
        payer,
        row,
        sys,
        &[prefix, from.as_ref(), to.as_ref()],
        EDGE_LEN,
    )?;
    let mut d = row.try_borrow_mut_data()?;
    d[0] = tag;
    d[1..33].copy_from_slice(from.as_ref());
    d[33..65].copy_from_slice(to.as_ref());
    d[65] = status;
    Ok(())
}
fn edge_is(
    program: &Pubkey,
    row: &AccountInfo,
    prefix: &[u8],
    tag: u8,
    from: &Pubkey,
    to: &Pubkey,
    status: u8,
) -> ProgramResult {
    pda(program, &[prefix, from.as_ref(), to.as_ref()], row)?;
    require(row.owner == program && row.data_len() == EDGE_LEN, 5)?;
    let d = row.try_borrow_data()?;
    require(d[0] == tag && d[65] == status, 5)
}
fn shop(program: &Pubkey, row: &AccountInfo, g: &Pubkey, merchant: &Pubkey) -> ProgramResult {
    pda(program, &[b"s3", g.as_ref(), merchant.as_ref()], row)?;
    require(
        row.owner == program
            && row.data_len() > SHOP_HEADER_LEN
            && row.try_borrow_data()?[0] == SHOP,
        5,
    )
}
fn authority(program: &Pubkey, who: &AccountInfo, auth: &AccountInfo) -> ProgramResult {
    signer(who)?;
    pda(program, &[b"auth3"], auth)?;
    require(auth.owner == program && auth.data_len() == 33, 5)?;
    let d = auth.try_borrow_data()?;
    require(d[0] == AUTHORITY && d[1..33] == who.key.to_bytes(), 5)
}
fn close_sender(program: &Pubkey, who: &AccountInfo, target: &AccountInfo,
    recipient: &AccountInfo, auth: &AccountInfo, seeds: &[&[u8]], tag: u8, len: usize) -> ProgramResult {
    authority(program, who, auth)?;
    pda(program, seeds, target)?;
    require(target.owner == program && target.data_len() == len &&
        target.try_borrow_data()?[0] == tag && target.key != recipient.key &&
        target.is_writable && recipient.is_writable, 5)?;
    let total = recipient.lamports().checked_add(target.lamports()).ok_or(err(5))?;
    **recipient.try_borrow_mut_lamports()? = total;
    **target.try_borrow_mut_lamports()? = 0;
    target.try_borrow_mut_data()?.fill(0);
    target.resize(0)?;
    target.assign(&system_program::id());
    Ok(())
}
pub fn process(program: &Pubkey, accounts: &[AccountInfo], op: u8, rest: &[u8]) -> ProgramResult {
    let mut it = accounts.iter();
    let who = next_account_info(&mut it)?;
    signer(who)?;
    if op == SET_AUTHORITY {
        require(rest.len() == 32, 5)?;
        let auth = next_account_info(&mut it)?;
        let executable = next_account_info(&mut it)?;
        let program_data = next_account_info(&mut it)?;
        let sys = next_account_info(&mut it)?;
        let loader = solana_program::bpf_loader_upgradeable::id();
        require(it.next().is_none() && executable.key == program && executable.owner == &loader &&
            executable.data_len() == 36 && program_data.owner == &loader && program_data.data_len() >= 45, 5)?;
        {
            let d = executable.try_borrow_data()?;
            let pd = program_data.try_borrow_data()?;
            require(u32::from_le_bytes(d[0..4].try_into().unwrap()) == 2 &&
                d[4..36] == program_data.key.to_bytes() &&
                u32::from_le_bytes(pd[0..4].try_into().unwrap()) == 3 &&
                pd[12] == 1 && pd[13..45] == who.key.to_bytes(), 5)?;
        }
        ensure_pda(program, who, auth, sys, &[b"auth3"], 33)?;
        let mut d = auth.try_borrow_mut_data()?;
        d[0] = AUTHORITY;
        d[1..33].copy_from_slice(rest);
        return Ok(());
    }
    if op == CLOSE_SENDER_ACCOUNT && rest == [0] {
        let user = next_account_info(&mut it)?;
        let target = next_account_info(&mut it)?;
        let recipient = next_account_info(&mut it)?;
        let auth = next_account_info(&mut it)?;
        require(it.next().is_none(), 5)?;
        return close_sender(program, who, target, recipient, auth,
            &[b"p3", user.key.as_ref()], WALLET, WALLET_LEN);
    }
    let g = next_account_info(&mut it)?;
    if op == CREATE_GROUP {
        // mode + invite verification public key + UTF-8 display metadata.
        require(
            rest.len() > POLICY_HEADER_LEN
                && rest.len() <= POLICY_HEADER_LEN + MAX_METADATA_LEN
                && rest[0] <= 2
                && std::str::from_utf8(&rest[33..]).is_ok(),
            5,
        )?;
        let mint = next_account_info(&mut it)?;
        let sys = next_account_info(&mut it)?;
        let token = next_account_info(&mut it)?;
        signer(g)?;
        require(
            g.owner == program
                && g.data_len() == 33 + rest.len()
                && g.try_borrow_data()?.iter().all(|b| *b == 0),
            5,
        )?;
        let bump = pda(program, &[b"w3", g.key.as_ref()], mint)?;
        require(*token.key == spl_token::id(), 5)?;
        create_pda(
            who,
            mint,
            sys,
            token.key,
            Mint::LEN,
            &[b"w3", g.key.as_ref(), &[bump]],
        )?;
        // The mint is also its signing PDA; it belongs to SPL Token.
        invoke(
            &spl_token::instruction::initialize_mint2(token.key, mint.key, mint.key, None, 0)?,
            &[mint.clone(), token.clone()],
        )?;
        let mut d = g.try_borrow_mut_data()?;
        d[0] = GROUP;
        d[1..33].copy_from_slice(who.key.as_ref());
        d[33..].copy_from_slice(rest);
        return Ok(());
    }
    let (owner, mode, invite) = group(g, program)?;
    match op {
        SPONSOR_JOIN => {
            let user = next_account_info(&mut it)?;
            let row = next_account_info(&mut it)?;
            let auth = next_account_info(&mut it)?;
            let sys = next_account_info(&mut it)?;
            require(rest.is_empty() && it.next().is_none() && *user.key != owner, 5)?;
            authority(program, who, auth)?;
            if row.owner == program {
                require(row.data_len() == EDGE_LEN, 5)?;
                let d = row.try_borrow_data()?;
                require(d[0] == MEMBER && (d[65] == 1 || d[65] == 2 || d[65] == LEFT), 5)?;
            }
            edge_set(program, who, row, sys, b"m3", MEMBER, g.key, user.key, 2)
        }
        CLOSE_SENDER_ACCOUNT => {
            require(rest == [1], 5)?;
            let user = next_account_info(&mut it)?;
            let target = next_account_info(&mut it)?;
            let recipient = next_account_info(&mut it)?;
            let auth = next_account_info(&mut it)?;
            require(it.next().is_none(), 5)?;
            close_sender(program, who, target, recipient, auth,
                &[b"m3", g.key.as_ref(), user.key.as_ref()], MEMBER, EDGE_LEN)
        }
        CERTIFY_SHOP => {
            // certify shop
            let merchant = next_account_info(&mut it)?;
            let row = next_account_info(&mut it)?;
            let sys = next_account_info(&mut it)?;
            require(
                *who.key == owner
                    && !rest.is_empty()
                    && rest.len() <= MAX_SHOP_NAME_LEN
                    && std::str::from_utf8(rest).is_ok(),
                5,
            )?;
            let bump = pda(
                program,
                &[b"s3", g.key.as_ref(), merchant.key.as_ref()],
                row,
            )?;
            create_pda(
                who,
                row,
                sys,
                program,
                SHOP_HEADER_LEN + rest.len(),
                &[b"s3", g.key.as_ref(), merchant.key.as_ref(), &[bump]],
            )?;
            let mut d = row.try_borrow_mut_data()?;
            d[0] = SHOP;
            d[1..33].copy_from_slice(g.key.as_ref());
            d[33..65].copy_from_slice(merchant.key.as_ref());
            d[65..].copy_from_slice(rest);
            Ok(())
        }
        JOIN_GROUP => {
            // self joins (open/invitation) or requests entry; founder may approve a pending request.
            let user = next_account_info(&mut it)?;
            let row = next_account_info(&mut it)?;
            let sys = next_account_info(&mut it)?;
            require(rest.len() == 1, 5)?;
            let status = if rest[0] == 1 {
                require(*who.key == owner && mode == 2, 5)?;
                edge_is(program, row, b"m3", MEMBER, g.key, user.key, 1)?;
                2
            } else {
                require(rest[0] == 0 && who.key == user.key, 5)?;
                // A pending applicant may join under the current policy after a mode change.
                if row.owner == program {
                    let previous = *row.try_borrow_data()?.last().ok_or(err(5))?;
                    require(previous == LEFT || (previous == 1 && mode != 2), 5)?;
                    edge_is(program, row, b"m3", MEMBER, g.key, user.key, previous)?;
                }
                if mode == 1 {
                    let code = next_account_info(&mut it)?;
                    signer(code)?;
                    require(*code.key == invite, 5)?;
                }
                if mode == 2 {
                    1
                } else {
                    2
                }
            };
            edge_set(
                program, who, row, sys, b"m3", MEMBER, g.key, user.key, status,
            )
        }
        END_MEMBERSHIP => {
            let user = next_account_info(&mut it)?;
            let row = next_account_info(&mut it)?;
            require(it.next().is_none() && *user.key != owner, 5)?;
            let next = match rest {
                [0] if who.key == user.key => LEFT,
                [1] if *who.key == owner => BANNED,
                _ => return Err(err(5)),
            };
            let previous = *row.try_borrow_data()?.last().ok_or(err(5))?;
            require(previous == 1 || previous == 2 || (next == BANNED && previous == LEFT), 5)?;
            edge_is(program, row, b"m3", MEMBER, g.key, user.key, previous)?;
            row.try_borrow_mut_data()?[65] = next;
            Ok(())
        }
        OFFER_ALLIANCE => {
            // outgoing offer; approval requires the other owner's signature on its own offer.
            let other = next_account_info(&mut it)?;
            group(other, program)?;
            let row = next_account_info(&mut it)?;
            let sys = next_account_info(&mut it)?;
            require(
                *who.key == owner && g.key != other.key && rest.len() == 1 && rest[0] <= 1,
                5,
            )?;
            edge_set(
                program, who, row, sys, b"a3", ALLY, g.key, other.key, rest[0],
            )
        }
        SPEND_INA => {
            require(rest.len() == 24, 5)?;
            let n = u64::from_le_bytes(rest[0..8].try_into().unwrap());
            let day = i64::from_le_bytes(rest[8..16].try_into().unwrap());
            let nonce = u64::from_le_bytes(rest[16..24].try_into().unwrap());
            let now = (Clock::get()?
                .unix_timestamp
                .checked_add(JST_OFFSET_SECONDS)
                .ok_or(err(1))?)
            .div_euclid(SECONDS_PER_DAY);
            require(now == day, 1)?;
            require(n > 0 && n <= LIMIT, 4)?;
            let merchant = next_account_info(&mut it)?;
            let shop_row = next_account_info(&mut it)?;
            let member = next_account_info(&mut it)?;
            let person = next_account_info(&mut it)?;
            let mint = next_account_info(&mut it)?;
            let dst = next_account_info(&mut it)?;
            let sys = next_account_info(&mut it)?;
            let token = next_account_info(&mut it)?;
            require(it.next().is_none(), 5)?;
            require(who.key != merchant.key, 6)?;
            shop(program, shop_row, g.key, merchant.key)?;
            if *who.key != owner {
                edge_is(program, member, b"m3", MEMBER, g.key, who.key, 2)?;
            }
            ensure_pda(
                program,
                who,
                person,
                sys,
                &[b"p3", who.key.as_ref()],
                WALLET_LEN,
            )?;
            let bump = pda(program, &[b"w3", g.key.as_ref()], mint)?;
            require(*token.key == spl_token::id() && mint.owner == token.key, 5)?;
            require(dst.owner == token.key, 5)?;
            let ac = TokenAccount::unpack(&dst.try_borrow_data()?)?;
            require(ac.mint == *mint.key && ac.owner == *merchant.key, 5)?;
            {
                let mut d = person.try_borrow_mut_data()?;
                let last = i64::from_le_bytes(d[1..9].try_into().unwrap());
                require(now >= last, 7)?;
                let old = if now == last {
                    u64::from_le_bytes(d[9..17].try_into().unwrap())
                } else {
                    0
                };
                require(
                    nonce == u64::from_le_bytes(d[17..25].try_into().unwrap()),
                    3,
                )?;
                let spent = old.checked_add(n).ok_or(err(2))?;
                require(spent <= LIMIT, 2)?;
                d[0] = WALLET;
                d[1..9].copy_from_slice(&now.to_le_bytes());
                d[9..17].copy_from_slice(&spent.to_le_bytes());
                d[17..25].copy_from_slice(&nonce.checked_add(1).ok_or(err(3))?.to_le_bytes());
            }
            invoke_signed(
                &spl_token::instruction::mint_to_checked(token.key, mint.key, dst.key,
                    mint.key, &[], n * SHOP_WARA_PER_INA, 0)?,
                &[mint.clone(), dst.clone(), token.clone()],
                &[&[b"w3", g.key.as_ref(), &[bump]]],
            )?;
            solana_program::msg!("WARA v3 Kusa payment; issuer:");
            g.key.log();
            Ok(())
        }
        TRANSFER_WARA => {
            // A register rechecks acceptance on-chain at transfer execution.
            let origin = next_account_info(&mut it)?;
            group(origin, program)?;
            let merchant = next_account_info(&mut it)?;
            let store = next_account_info(&mut it)?;
            shop(program, store, g.key, merchant.key)?;
            require(rest.len() == 8 && who.key != merchant.key, 5)?;
            let n = u64::from_le_bytes(rest.try_into().unwrap());
            require(n > 0, 4)?;
            if g.key != origin.key {
                edge_is(
                    program,
                    next_account_info(&mut it)?,
                    b"a3",
                    ALLY,
                    g.key,
                    origin.key,
                    1,
                )?;
                edge_is(
                    program,
                    next_account_info(&mut it)?,
                    b"a3",
                    ALLY,
                    origin.key,
                    g.key,
                    1,
                )?;
            }
            let mint = next_account_info(&mut it)?;
            pda(program, &[b"w3", origin.key.as_ref()], mint)?;
            let src = next_account_info(&mut it)?;
            let dst = next_account_info(&mut it)?;
            let token = next_account_info(&mut it)?;
            require(
                *token.key == spl_token::id() && dst.owner == token.key && src.owner == token.key,
                5,
            )?;
            for (a, w) in [(src, who.key), (dst, merchant.key)] {
                let d = TokenAccount::unpack(&a.try_borrow_data()?)?;
                require(d.owner == *w && d.mint == *mint.key, 5)?;
            }
            invoke(
                &spl_token::instruction::transfer_checked(
                    token.key,
                    src.key,
                    mint.key,
                    dst.key,
                    who.key,
                    &[],
                    n,
                    0,
                )?,
                &[
                    src.clone(),
                    mint.clone(),
                    dst.clone(),
                    who.clone(),
                    token.clone(),
                ],
            )
        }
        UPDATE_GROUP => {
            // Update the group's policy only. No mint, token or membership accounts.
            let sys = next_account_info(&mut it)?;
            require(
                *who.key == owner && *sys.key == system_program::id() && it.next().is_none(),
                5,
            )?;
            // Compare the policy that the administrator saw before signing.
            require(
                rest.len() > 2 * POLICY_HEADER_LEN
                    && rest.len() <= 2 * POLICY_HEADER_LEN + MAX_METADATA_LEN
                    && rest[0] == mode
                    && rest[1..33] == invite.to_bytes(),
                5,
            )?;
            let next = &rest[33..];
            require(next[0] <= 2 && std::str::from_utf8(&next[33..]).is_ok(), 5)?;
            let size = 33 + next.len();
            let missing = Rent::get()?
                .minimum_balance(size)
                .saturating_sub(g.lamports());
            if missing > 0 {
                invoke(
                    &system_instruction::transfer(who.key, g.key, missing),
                    &[who.clone(), g.clone(), sys.clone()],
                )?;
            }
            g.resize(size)?;
            g.try_borrow_mut_data()?[33..].copy_from_slice(next);
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
