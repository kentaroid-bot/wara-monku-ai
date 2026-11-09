//! Devnet research prototype. Rights are per wallet, not proof of unique humanity.
//! No unused tokens are issued. Only accepted payments mint enduring credit.
#![allow(unexpected_cfgs)]
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo}, clock::Clock, entrypoint,
    entrypoint::ProgramResult, program::{invoke, invoke_signed}, program_error::ProgramError,
    program_option::COption, program_pack::Pack, pubkey::Pubkey, rent::Rent,
    system_instruction, system_program, sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, Mint};

mod v3;
entrypoint!(process_instruction);
const LEGACY_LIMIT: u64 = 300;
pub const CONFIG_LEN: usize = 81; // tag + creator + mint + period + offset
pub const PERSON_LEN: usize = 89; // tag + config + wallet + day + spent + nonce

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Config { tag: u8, creator: Pubkey, mint: Pubkey, period: i64, offset: i64 }
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Person { tag: u8, config: Pubkey, wallet: Pubkey, day: i64, spent: u64, nonce: u64 }

#[derive(BorshDeserialize)]
struct MetadataInput { name: String, symbol: String, uri: String }

// Custom errors: 0 invalid config, 1 invalid day, 2 limit, 3 nonce/replay,
// 4 invalid amount, 5 invalid account, 6 self-payment, 7 clock rollback.
fn err(code: u32) -> ProgramError { ProgramError::Custom(code) }
fn require(ok: bool, code: u32) -> ProgramResult { if ok { Ok(()) } else { Err(err(code)) } }
fn signer(a: &AccountInfo) -> ProgramResult {
    if a.is_signer { Ok(()) } else { Err(ProgramError::MissingRequiredSignature) }
}
fn config(a: &AccountInfo, program: &Pubkey) -> Result<Config, ProgramError> {
    require(a.owner == program && a.data_len() == CONFIG_LEN, 0)?;
    let c = Config::try_from_slice(&a.try_borrow_data()?).map_err(|_| err(0))?;
    require(c.tag == 1 && (c.period == 86400 || c.period == 120), 0)?;
    Ok(c)
}
fn store<T: BorshSerialize>(a: &AccountInfo, value: &T) -> ProgramResult {
    value.serialize(&mut &mut a.try_borrow_mut_data()?[..]).map_err(|_| err(5))
}
fn day(c: &Config) -> Result<i64, ProgramError> {
    let time = Clock::get()?.unix_timestamp;
    require(time >= 0, 1)?;
    Ok(time.checked_add(c.offset).ok_or(err(1))?.div_euclid(c.period))
}
// Allocate a PDA even if someone has pre-funded it with dust. Never overwrite state.
fn create_pda<'a>(payer: &AccountInfo<'a>, account: &AccountInfo<'a>, sys: &AccountInfo<'a>,
    owner: &Pubkey, len: usize, seeds: &[&[u8]]) -> ProgramResult {
    require(*sys.key == system_program::id(), 5)?;
    require(*account.owner == system_program::id() && account.data_is_empty(), 5)?;
    let missing = Rent::get()?.minimum_balance(len).saturating_sub(account.lamports());
    if missing > 0 {
        invoke(&system_instruction::transfer(payer.key, account.key, missing),
            &[payer.clone(), account.clone(), sys.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(account.key, len as u64),
        &[account.clone(), sys.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(account.key, owner),
        &[account.clone(), sys.clone()], &[seeds])
}

pub fn process_instruction(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&op, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let mut it = accounts.iter();
    match op {
        // Initialize: config is a newly-created signer account owned by this program.
        // period=86400 uses JST midnight; period=120 is explicitly accelerated Devnet testing.
        0 => {
            require(rest.len() == 8, 0)?;
            let period = i64::from_le_bytes(rest.try_into().unwrap());
            require(period == 86400 || period == 120, 0)?;
            let payer=next_account_info(&mut it)?; let cfg=next_account_info(&mut it)?;
            let mint=next_account_info(&mut it)?; let authority=next_account_info(&mut it)?;
            let sys=next_account_info(&mut it)?; let token=next_account_info(&mut it)?;
            signer(payer)?; signer(cfg)?;
            require(cfg.owner == program && cfg.data_len() == CONFIG_LEN, 0)?;
            require(cfg.try_borrow_data()?.iter().all(|b| *b == 0), 0)?;
            require(*token.key == spl_token::id(), 5)?;
            let (m, bump)=Pubkey::find_program_address(&[b"mint",cfg.key.as_ref()],program);
            let (a,_)=Pubkey::find_program_address(&[b"authority",cfg.key.as_ref()],program);
            require(m == *mint.key && a == *authority.key, 5)?;
            create_pda(payer,mint,sys,&spl_token::id(),Mint::LEN,&[b"mint",cfg.key.as_ref(),&[bump]])?;
            invoke(&spl_token::instruction::initialize_mint2(token.key,mint.key,authority.key,None,0)?,
                &[mint.clone(),token.clone()])?;
            store(cfg,&Config {tag:1,creator:*payer.key,mint:m,period,offset:if period==86400 {32400} else {0}})
        },
        // Permissionless Devnet enrollment: one account per wallet per instance. No minting.
        1 => {
            require(rest.is_empty(),5)?;
            let wallet=next_account_info(&mut it)?; let cfg=next_account_info(&mut it)?;
            let person=next_account_info(&mut it)?; let sys=next_account_info(&mut it)?;
            signer(wallet)?; let c=config(cfg,program)?;
            let (p,bump)=Pubkey::find_program_address(&[b"person",cfg.key.as_ref(),wallet.key.as_ref()],program);
            require(p == *person.key,5)?;
            create_pda(wallet,person,sys,program,PERSON_LEN,&[b"person",cfg.key.as_ref(),wallet.key.as_ref(),&[bump]])?;
            store(person,&Person {tag:2,config:*cfg.key,wallet:*wallet.key,day:day(&c)?,spent:0,nonce:0})
        },
        // The consumer alone authorizes payment. Consumption and mint CPI are atomic.
        2 => {
            require(rest.len()==24,5)?;
            let amount=u64::from_le_bytes(rest[0..8].try_into().unwrap());
            let expected_day=i64::from_le_bytes(rest[8..16].try_into().unwrap());
            let expected_nonce=u64::from_le_bytes(rest[16..24].try_into().unwrap());
            let consumer=next_account_info(&mut it)?; let producer=next_account_info(&mut it)?;
            let cfg=next_account_info(&mut it)?; let person=next_account_info(&mut it)?;
            let mint=next_account_info(&mut it)?; let destination=next_account_info(&mut it)?;
            let authority=next_account_info(&mut it)?; let token=next_account_info(&mut it)?;
            signer(consumer)?;
            require(consumer.key != producer.key,6)?;
            let c=config(cfg,program)?;
            let now=day(&c)?;
            require(expected_day==now,1)?;
            require(amount>0 && amount<=LEGACY_LIMIT,4)?;
            require(*token.key==spl_token::id() && mint.owner==token.key && destination.owner==token.key,5)?;
            require(*mint.key==c.mint,5)?;
            let (a,bump)=Pubkey::find_program_address(&[b"authority",cfg.key.as_ref()],program);
            require(*authority.key==a,5)?;
            let m=Mint::unpack(&mint.try_borrow_data()?)?;
            require(m.mint_authority==COption::Some(a) && m.decimals==0 && m.freeze_authority==COption::None,5)?;
            let dst=TokenAccount::unpack(&destination.try_borrow_data()?)?;
            require(dst.mint==c.mint && dst.owner==*producer.key,5)?;
            let (p,_)=Pubkey::find_program_address(&[b"person",cfg.key.as_ref(),consumer.key.as_ref()],program);
            require(*person.key==p && person.owner==program && person.data_len()==PERSON_LEN,5)?;
            let mut state=Person::try_from_slice(&person.try_borrow_data()?).map_err(|_|err(5))?;
            require(state.tag==2 && state.config==*cfg.key && state.wallet==*consumer.key,5)?;
            require(state.nonce==expected_nonce,3)?;
            require(now>=state.day,7)?;
            if now>state.day {state.day=now;state.spent=0;}
            state.spent=state.spent.checked_add(amount).ok_or(err(2))?;
            require(state.spent<=LEGACY_LIMIT,2)?;
            state.nonce=state.nonce.checked_add(1).ok_or(err(3))?;
            store(person,&state)?;
            invoke_signed(&spl_token::instruction::mint_to_checked(token.key,mint.key,destination.key,authority.key,&[],amount,0)?,
                &[mint.clone(),destination.clone(),authority.clone(),token.clone()],
                &[&[b"authority",cfg.key.as_ref(),&[bump]]])
        },
        // Add metadata to an EXISTING mint. Only its config creator may authorize this.
        // The mint PDA stays the mint authority; no supply/allowance/account changes.
        3 => {
            let input=MetadataInput::try_from_slice(rest).map_err(|_|err(5))?;
            require(!input.name.is_empty() && input.name.len()<=32 && !input.name.contains('\0'),5)?;
            require(!input.symbol.is_empty() && input.symbol.len()<=10 && !input.symbol.contains('\0'),5)?;
            require(input.uri.starts_with("https://") && input.uri.len()<=200 && !input.uri.contains('\0'),5)?;
            let creator=next_account_info(&mut it)?; let cfg=next_account_info(&mut it)?;
            let mint=next_account_info(&mut it)?; let authority=next_account_info(&mut it)?;
            let metadata=next_account_info(&mut it)?; let mpl=next_account_info(&mut it)?;
            let sys=next_account_info(&mut it)?; let instructions=next_account_info(&mut it)?;
            let token=next_account_info(&mut it)?;
            signer(creator)?; let c=config(cfg,program)?;
            require(*creator.key==c.creator,5)?;
            require(*mpl.key==mpl_token_metadata::ID && mpl.executable,5)?;
            require(*sys.key==system_program::id() && *token.key==spl_token::id(),5)?;
            require(*instructions.key==solana_program::sysvar::instructions::id(),5)?;
            require(*mint.key==c.mint && mint.owner==token.key,5)?;
            let (a,bump)=Pubkey::find_program_address(&[b"authority",cfg.key.as_ref()],program);
            require(*authority.key==a,5)?;
            let m=Mint::unpack(&mint.try_borrow_data()?)?;
            require(m.mint_authority==COption::Some(a) && m.decimals==0 && m.freeze_authority==COption::None,5)?;
            let (expected,_)=mpl_token_metadata::accounts::Metadata::find_pda(mint.key);
            require(*metadata.key==expected && metadata.owner==&system_program::id() && metadata.data_is_empty(),5)?;
            mpl_token_metadata::instructions::CreateV1CpiBuilder::new(mpl)
                .metadata(metadata).mint(mint,false).authority(authority).payer(creator)
                .update_authority(creator,true).system_program(sys).sysvar_instructions(instructions)
                .spl_token_program(Some(token)).name(input.name).symbol(input.symbol).uri(input.uri)
                .seller_fee_basis_points(0).primary_sale_happened(false).is_mutable(true)
                .token_standard(mpl_token_metadata::types::TokenStandard::Fungible).decimals(0)
                .invoke_signed(&[&[b"authority",cfg.key.as_ref(),&[bump]]])
        },
        10..=15 => v3::process(program,accounts,op,rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
